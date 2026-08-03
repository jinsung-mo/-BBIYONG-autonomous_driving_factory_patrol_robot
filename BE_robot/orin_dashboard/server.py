#!/usr/bin/env python3
"""
OrinCar 개발 대시보드 — Orin 측 데이터 수집·서빙 서버

설계 원칙
  - 표준 라이브러리만 사용한다. 로봇에 pip 의존성을 늘리지 않는다.
  - 비싼 명령(tegrastats, ros2 topic hz)은 요청마다 실행하지 않는다.
    백그라운드 스레드가 상주 프로세스로 띄워두고 출력을 계속 읽어 공유 상태를 갱신한다.
  - 폴링(/api/state)과 SSE(/api/stream)를 둘 다 제공한다.
    프런트가 어느 쪽을 쓸지는 프런트가 정한다.

실행
  source /opt/ros/humble/setup.bash
  source ~/ydlidar_ros2_ws/install/setup.bash
  python3 server.py --port 8090

엔드포인트
  GET /api/ws       WebSocket. 1초마다 상태를 밀고, 클라이언트 명령을 받는다 (주 경로)
  GET /api/state    현재 상태 스냅샷 (JSON) — 디버깅·curl 확인용
  GET /api/stream   1초마다 상태를 밀어주는 SSE — WS 가 막히는 환경 대비 폴백
  GET /api/health   살아있는지만 확인
  GET  /api/nav/live  고빈도 자세·스캔과 현재 지도 sequence
  GET  /api/nav/map   변경 시에만 받는 RLE 지도 snapshot/patch
  GET  /api/nav       구형 클라이언트 호환용 전체 지도
  GET  /api/cam     카메라 영상·검출 (camera_node.py 가 떨군 것)
  GET  /api/drive   수동 조종 상태 (bbiyong_manual_drive_bridge가 기록)
  POST /api/drive   🔴 **수동 조종 명령 — 유일하게 로봇을 움직이는 경로**
  GET /*            static/ 아래 정적 파일
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import wsproto

# ─────────────────────────────────────────────────────────────
# 공유 상태 — 수집 스레드가 쓰고 HTTP 핸들러가 읽는다
# ─────────────────────────────────────────────────────────────
STATE_LOCK = threading.Lock()
STATE = {
    "ts": None,              # 이 스냅샷을 만든 시각 (epoch 초)
    "system": {},            # tegrastats 파싱 결과
    "thermal": {},           # 존별 온도 °C
    "disk": {},              # 루트 파티션
    "uptime_sec": None,
    "ros": {                 # ROS 2 상태
        "topics": [],
        "scan_hz": None,
        "scan_hz_t": 0.0,    # 위 값을 마지막으로 실제 관측한 시각. 신선도 판정용
    },
    "motor": {               # ESP32 미연결이면 전부 None
        "connected": False,
        "left": {}, "right": {},
    },
    "battery": {             # INA226 미배선이면 전부 None
        "connected": False,
        "volts": None, "percent": None,
    },
    "errors": {},            # 수집기별 마지막 오류 메시지
}


def _set(path, value):
    """STATE['a']['b'] = value 를 락 걸고 수행한다."""
    with STATE_LOCK:
        node = STATE
        for key in path[:-1]:
            node = node.setdefault(key, {})
        node[path[-1]] = value
        STATE["ts"] = time.time()


# ─────────────────────────────────────────────────────────────
# 수집기 1 — tegrastats (CPU/GPU/RAM/온도/전력)
# ─────────────────────────────────────────────────────────────
# 예시 한 줄:
# RAM 1650/7620MB ... CPU [8%@729,16%@729,...] GR3D_FREQ 6% cpu@44C ...
#   VDD_IN 3491mW/3491mW VDD_CPU_GPU_CV 642mW/642mW VDD_SOC 1083mW/1083mW
RE_RAM = re.compile(r"RAM (\d+)/(\d+)MB")
RE_SWAP = re.compile(r"SWAP (\d+)/(\d+)MB")
RE_CPU = re.compile(r"CPU \[([^\]]+)\]")
RE_GR3D = re.compile(r"GR3D_FREQ (\d+)%")
RE_POWER = re.compile(r"(VDD_[A-Z_0-9]+) (\d+)mW/(\d+)mW")


def collect_tegrastats():
    if not shutil.which("tegrastats"):
        _set(["errors", "tegrastats"], "tegrastats 없음")
        return
    proc = subprocess.Popen(
        ["tegrastats", "--interval", "1000"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    for line in proc.stdout:
        sysinfo = {}

        if (m := RE_RAM.search(line)):
            sysinfo["ram_used_mb"], sysinfo["ram_total_mb"] = int(m[1]), int(m[2])
        if (m := RE_SWAP.search(line)):
            sysinfo["swap_used_mb"], sysinfo["swap_total_mb"] = int(m[1]), int(m[2])
        if (m := RE_GR3D.search(line)):
            sysinfo["gpu_percent"] = int(m[1])

        if (m := RE_CPU.search(line)):
            cores, freqs = [], []
            for part in m[1].split(","):
                # "8%@729" 또는 "off"
                if "@" in part:
                    pct, freq = part.split("@")
                    cores.append(int(pct.rstrip("%")))
                    freqs.append(int(freq))
                else:
                    cores.append(None)
            sysinfo["cpu_cores"] = cores
            sysinfo["cpu_freq_mhz"] = max(freqs) if freqs else None

        power = {name: int(cur) for name, cur, _avg in RE_POWER.findall(line)}
        if power:
            sysinfo["power_mw"] = power
            sysinfo["power_total_mw"] = power.get("VDD_IN")

        if sysinfo:
            _set(["system"], sysinfo)


# ─────────────────────────────────────────────────────────────
# 수집기 2 — 온도 / 디스크 / 업타임 (싸므로 주기 폴링)
# ─────────────────────────────────────────────────────────────
THERMAL_ROOT = "/sys/devices/virtual/thermal"


def collect_slow():
    while True:
        try:
            temps = {}
            for entry in sorted(os.listdir(THERMAL_ROOT)):
                if not entry.startswith("thermal_zone"):
                    continue
                zone = os.path.join(THERMAL_ROOT, entry)
                try:
                    # sysfs 는 바이너리로 읽는다.
                    # cv0~cv2(미사용 코어) 같은 존은 커널에서 temp 읽기가 실패하는데,
                    # 텍스트 모드로 읽으면 codecs 내부에서 TypeError 가 난다.
                    # 예외 종류를 좁게 잡으면 이 존 하나 때문에 수집기 전체가 멈춘다.
                    with open(os.path.join(zone, "type"), "rb") as f:
                        name = f.read().decode().strip()
                    with open(os.path.join(zone, "temp"), "rb") as f:
                        milli = int(f.read().decode().strip())
                except Exception:                     # noqa: BLE001
                    continue                          # 이 존만 건너뛴다
                if milli > 0:
                    temps[name] = round(milli / 1000, 1)
            _set(["thermal"], temps)

            usage = shutil.disk_usage("/")
            _set(["disk"], {
                "total_gb": round(usage.total / 1e9, 1),
                "used_gb": round(usage.used / 1e9, 1),
                "percent": round(usage.used / usage.total * 100),
            })

            with open("/proc/uptime") as f:
                _set(["uptime_sec"], int(float(f.read().split()[0])))

            # 한 번 성공하면 이전 오류 표시를 지운다.
            # 안 지우면 복구된 뒤에도 프런트에 계속 빨간불이 남는다.
            with STATE_LOCK:
                STATE["errors"].pop("slow", None)
        except Exception as exc:                      # noqa: BLE001
            _set(["errors", "slow"], f"{type(exc).__name__}: {exc}")
        time.sleep(5)


# ─────────────────────────────────────────────────────────────
# 수집기 3 — ROS 2 (토픽 목록 + /scan 실측 주기)
# ─────────────────────────────────────────────────────────────
RE_HZ = re.compile(r"average rate: ([\d.]+)")


SCAN_STALE_S = 5.0          # 이보다 오래된 주기값은 "모름"이다


def collect_ros_topics():
    """토픽 목록은 5초마다 갱신. ros2 topic list 는 금방 끝난다."""
    while True:
        try:
            out = subprocess.run(
                ["ros2", "topic", "list"],
                capture_output=True, text=True, timeout=10,
            )
            topics = sorted(t for t in out.stdout.split() if t.startswith("/"))
            _set(["ros", "topics"], topics)
        except Exception as exc:                      # noqa: BLE001
            _set(["errors", "ros_topics"], str(exc))

        # /scan 주기의 신선도 판정을 **여기서** 한다 — collect_scan_hz 안이 아니라.
        # 이유는 그쪽 docstring 참조. 이 루프는 절대 블로킹되지 않으므로
        # 발행자가 사라져도 반드시 돌아 값을 None 으로 되돌린다.
        with STATE_LOCK:
            ros = STATE.get("ros", {})
            stale = (ros.get("scan_hz") is not None and
                     time.time() - ros.get("scan_hz_t", 0) > SCAN_STALE_S)
        if stale:
            _set(["ros", "scan_hz"], None)      # 대시보드는 "—" 로 표시된다
        time.sleep(5)


def collect_scan_hz():
    """
    ros2 topic hz 는 블로킹 도구다. 한 번만 띄워두고 출력 줄을 계속 읽는다.

    🔴 "무소식이면 None" 판정을 **이 루프 안에서 하면 안 된다.**
       /scan 발행자가 사라지면 `ros2 topic hz` 는 경고조차 안 찍고 침묵한다.
       그러면 `for line in proc.stdout` 이 read 에서 블로킹돼 루프 몸통이
       **한 번도 실행되지 않고**, 판정문은 영원히 도달하지 못한다.
       실제로 라이다 드라이버를 내린 뒤에도 대시보드가 5.3Hz 를 계속 띄웠다.
       (11.6Hz 의 절반 — 종료 순간의 반쪽 윈도우가 그대로 박제됐다.)

       → 흐름이 멈춘 것을 감지하는 코드는 **그 흐름 밖**에 있어야 한다.
         여기서는 값과 시각만 남기고, 판정은 collect_ros_topics 가 한다.
    """
    while True:
        proc = subprocess.Popen(
            ["ros2", "topic", "hz", "/scan"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        try:
            for line in proc.stdout:
                if (m := RE_HZ.search(line)):
                    _set(["ros", "scan_hz"], round(float(m[1]), 2))
                    _set(["ros", "scan_hz_t"], time.time())
        except Exception as exc:                      # noqa: BLE001
            _set(["errors", "scan_hz"], str(exc))
        finally:
            proc.kill()
        _set(["ros", "scan_hz"], None)
        time.sleep(3)          # 드라이버가 죽었을 수 있으니 잠시 후 재시도


# ─────────────────────────────────────────────────────────────
# 수집기 4 — ESP32 (아직 미연결. 자리만 잡아둔다)
# ─────────────────────────────────────────────────────────────
def collect_esp32():
    """
    ESP32 가 USB 로 붙고 펌웨어가 시리얼로 값을 뱉기 시작하면 여기서 읽는다.
    시리얼 프레임 포맷이 아직 정의되지 않았으므로, 지금은 '장치가 있는지'만 본다.

    주의: /dev/ttyUSB0 는 현재 LiDAR(CP210x)가 쓰고 있다.
         ESP32 를 꽂으면 ttyUSB1 로 잡히거나 순서가 뒤바뀔 수 있어,
         나중에 udev 규칙으로 고정 심볼릭 링크를 만드는 편이 안전하다.
    """
    while True:
        try:
            out = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=5)
            # CP210x 는 LiDAR 다. ESP32 DevKit V1 은 보통 CH340(1a86:7523).
            found = "1a86:7523" in out.stdout or "10c4:ea60" in out.stdout.replace(
                "10c4:ea60", "", 1)   # 두 번째 CP210x 부터가 ESP32 후보
            _set(["motor", "connected"], bool(found))
        except Exception as exc:                      # noqa: BLE001
            _set(["errors", "esp32"], str(exc))
        time.sleep(5)


# ─────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
# nav_bridge.py writes live data frequently, but map files only on map changes.
NAV_LIVE_FILE = os.environ.get(
    "ORINCAR_NAV_LIVE_FILE", "/tmp/orincar_nav_live.json"
)
NAV_MAP_FILE = os.environ.get(
    "ORINCAR_NAV_MAP_FILE", "/tmp/orincar_nav_map.json"
)
NAV_MAP_UPDATE_FILE = os.environ.get(
    "ORINCAR_NAV_MAP_UPDATE_FILE", "/tmp/orincar_nav_map_update.json"
)
# camera_node.py 가 여기에 JPEG(base64) + 검출 + 바닥판정을 떨군다
CAM_FILE = os.environ.get("ORINCAR_CAM_FILE", "/tmp/orincar_cam.json")
# 수동 조종 — 파일 명령은 resident manual bridge와 cmd mux를 거쳐 /cmd_vel로 전달된다.
# server.py 는 표준 라이브러리만 쓰므로 ROS 발행은 그 노드가 맡는다.
DRIVE_FILE = os.environ.get("ORINCAR_DRIVE_FILE", "/tmp/orincar_drive.json")
DRIVE_STATUS_FILE = os.environ.get("ORINCAR_DRIVE_STATUS", "/tmp/orincar_drive_status.json")
# 서버에서도 한 번 자른다. 최종 상한은 teleop_node 가 다시 건다(이중 방어).
DRIVE_V_MAX, DRIVE_W_MAX = 0.15, 0.60


def handle_command(ws, message: str):
    """
    클라이언트 → 서버 명령. 지금은 ping 만 의미가 있다.

    모터 조종(DRIVE 등)은 ESP32 펌웨어와 시리얼 프레임 포맷이 정해진 뒤에 붙인다.
    그때까지는 알 수 없는 명령에 명시적으로 거절을 돌려준다 — 조용히 무시하면
    프런트가 "보냈는데 왜 안 되지"로 헤매게 된다.
    """
    try:
        cmd = json.loads(message)
    except json.JSONDecodeError:
        ws.send_text(json.dumps({"type": "error", "reason": "JSON 파싱 실패"}))
        return

    kind = cmd.get("type")

    if kind == "ping":
        ws.send_text(json.dumps({"type": "pong", "ts": time.time()}))
        return

    ws.send_text(json.dumps({
        "type": "nack",
        "of": kind,
        "reason": "미구현",
        "detail": "모터 제어는 ESP32 펌웨어·시리얼 포맷 확정 후 연결됩니다",
    }, ensure_ascii=False))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass                                          # 접속 로그로 콘솔을 더럽히지 않는다

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")   # 개발 중 프런트 dev 서버용
        self.end_headers()
        self.wfile.write(body)

    def _json_file(self, path, who="nav_bridge.py", etag=None):
        try:
            with open(path, "rb") as file:
                body = file.read()
            age = max(0.0, time.time() - os.path.getmtime(path))
        except FileNotFoundError:
            return self._json(
                {
                    "error": f"{who} 가 실행 중이 아닙니다",
                    "hint": f"python3 {who}",
                },
                503,
            )
        except OSError as exc:
            return self._json({"error": str(exc)}, 500)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Nav-Age", f"{age:.2f}")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def _nav_map(self, query):
        try:
            with open(NAV_MAP_FILE, encoding="utf-8") as file:
                snapshot = json.load(file)
            current = int(snapshot["sequence"])
        except FileNotFoundError:
            return self._json(
                {"error": "nav_bridge.py 가 실행 중이 아닙니다"}, 503
            )
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return self._json({"error": f"invalid map snapshot: {exc}"}, 500)

        since_values = parse_qs(query).get("since", [])
        try:
            since = int(since_values[0]) if since_values else None
        except ValueError:
            return self._json({"error": "since must be an integer"}, 400)
        etag = f'"map-{current}"'
        if since == current:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        payload = snapshot
        if since is not None:
            try:
                with open(NAV_MAP_UPDATE_FILE, encoding="utf-8") as file:
                    update = json.load(file)
                if (
                    update.get("kind") == "patch"
                    and update.get("base_sequence") == since
                    and update.get("sequence") == current
                ):
                    payload = update
            except (OSError, json.JSONDecodeError):
                pass
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def _legacy_nav(self):
        """Compatibility only; current dashboard uses /live and /map."""
        try:
            with open(NAV_LIVE_FILE, encoding="utf-8") as file:
                live = json.load(file)
            with open(NAV_MAP_FILE, encoding="utf-8") as file:
                encoded_map = json.load(file)
            cells = []
            runs = encoded_map["cells"]
            symbols = {-1: ".", 0: " ", 100: "#"}
            for value, count in zip(runs[::2], runs[1::2]):
                cells.append(symbols[int(value)] * int(count))
            nav_map = {
                key: encoded_map[key]
                for key in ("w", "h", "res", "ox", "oy")
            }
            nav_map["seq"] = encoded_map["sequence"]
            nav_map["data"] = "".join(cells)
            return self._json(
                {
                    "t": live.get("t"),
                    "pose": live.get("pose"),
                    "scan": live.get("scan"),
                    "map": nav_map,
                }
            )
        except FileNotFoundError:
            return self._json(
                {"error": "nav_bridge.py 가 실행 중이 아닙니다"}, 503
            )
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return self._json({"error": f"invalid nav data: {exc}"}, 500)

    def do_GET(self):                                 # noqa: N802
        request = urlsplit(self.path)
        path = request.path

        if path == "/api/health":
            return self._json({"ok": True})

        if path == "/api/state":
            with STATE_LOCK:
                return self._json(json.loads(json.dumps(STATE)))

        if path == "/api/drive":
            # 조종 상태 조회 (teleop_node 가 쓴 것). 없으면 미실행이다.
            try:
                with open(DRIVE_STATUS_FILE) as f:
                    body = f.read()
            except OSError:
                return self._json({"error": "teleop_node 가 실행 중이 아닙니다",
                                   "hint": "start the persistent BBIYONG runtime"}, 503)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body.encode())))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode())
            return

        if path == "/api/nav/live":
            return self._json_file(NAV_LIVE_FILE)

        if path == "/api/nav/map":
            return self._nav_map(request.query)

        if path == "/api/nav":
            return self._legacy_nav()

        if path == "/api/cam":
            # 외부 프로세스가 떨군 스냅샷을 그대로 흘려보낸다.
            # ROS·OpenCV 의존부는 그쪽에 있고 여기는 파일만 읽는다
            # (server.py 는 표준 라이브러리만 쓴다는 원칙 유지).
            src, who = CAM_FILE, "camera_node.py"
            try:
                with open(src, "r") as f:
                    body = f.read()
            except FileNotFoundError:
                return self._json(
                    {"error": f"{who} 가 실행 중이 아닙니다",
                     "hint": f"python3 {who}"}, 503)
            except OSError as exc:
                return self._json({"error": str(exc)}, 500)
            # 신선도는 **서버에서** 계산해 보낸다. 브라우저가 자기 시계로
            # (Date.now() − payload.t) 를 재면 Orin 과 PC 의 시계 차이가 그대로
            # 섞여 음수가 나온다(실제로 −0.5s 로 관측).
            try:
                age = max(0.0, time.time() - os.path.getmtime(src))
            except OSError:
                age = -1.0
            raw = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Nav-Age", f"{age:.2f}")
            self.end_headers()
            self.wfile.write(raw)
            return

        if path == "/api/ws":
            return self._websocket()

        if path == "/api/stream":
            return self._sse()

        return self._static(path)

    def do_POST(self):                                # noqa: N802
        """수동 조종 명령. 파일로 떨구고 resident manual bridge가 읽어 간다.

        🔴 이 엔드포인트만이 **물리 로봇을 움직인다.** 나머지는 전부 조회다.
           서버에서 상한을 자르고, teleop_node 가 데드맨·라이다 가드·순찰 충돌
           검사를 다시 한다. 방어를 한 곳에 몰지 않는다.
        """
        path = self.path.split("?")[0]
        if path != "/api/drive":
            return self._json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > 4096:
                return self._json({"error": "본문 크기가 이상합니다"}, 400)
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError) as exc:
            return self._json({"error": f"본문 파싱 실패: {exc}"}, 400)

        try:
            v = max(-DRIVE_V_MAX, min(DRIVE_V_MAX, float(data.get("v", 0.0))))
            w = max(-DRIVE_W_MAX, min(DRIVE_W_MAX, float(data.get("w", 0.0))))
        except (TypeError, ValueError):
            return self._json({"error": "v·w 는 숫자여야 합니다"}, 400)

        cmd = {"armed": bool(data.get("armed", False)),
               "v": v, "w": w, "ts": time.time()}
        tmp = DRIVE_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(cmd, f)
            os.replace(tmp, DRIVE_FILE)      # 원자적 교체
        except OSError as exc:
            return self._json({"error": str(exc)}, 500)
        # 🔴 응답을 **상태와 같은 모양으로 만들지 않는다.** GET /api/drive 는
        #    teleop_node 가 판단한 `reason`·`patrol_running` 을 주지만, POST 시점엔
        #    아직 그 판단이 없다(비동기). 같은 평면 모양으로 돌려주면 소비자가
        #    상태로 오해해 `reason` 이 사라진다 — 실제로 그 버그가 났다.
        #    받아들인 명령을 `accepted` 안에 넣어 **상태가 아님을 형태로 표시**한다.
        return self._json({"ok": True, "accepted": cmd,
                           "note": "상태는 GET /api/drive 로 따로 조회할 것"})

    # ── WebSocket ────────────────────────────────────────────
    def _websocket(self):
        """
        HTTP 연결을 WebSocket 으로 승격시킨 뒤, 이 스레드가 송신 루프를 맡는다.
        수신(명령·ping)은 별도 스레드가 처리한다.
        ThreadingHTTPServer 라 연결마다 스레드가 하나 있으므로 여기서 블로킹해도 된다.
        """
        if self.headers.get("Upgrade", "").lower() != "websocket":
            return self._json({"error": "Upgrade: websocket 헤더가 필요합니다"}, 400)

        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._json({"error": "Sec-WebSocket-Key 가 없습니다"}, 400)

        # BaseHTTPRequestHandler 의 응답 헬퍼를 거치지 않고 직접 쓴다.
        # 101 이후로는 HTTP 가 아니라 WebSocket 프레임이 흐르기 때문이다.
        self.wfile.write(wsproto.handshake_response(key))
        self.wfile.flush()
        self.close_connection = True          # 핸들러 종료 시 소켓을 정리하게 한다

        ws = wsproto.WebSocket(self.connection, threading.Lock())

        def reader():
            """클라이언트가 보내는 명령을 처리한다. ping/close 는 래퍼가 알아서 처리."""
            try:
                while not ws.closed:
                    message = ws.read()
                    handle_command(ws, message)
            except (wsproto.ClosedError, OSError):
                pass
            except wsproto.WebSocketError as exc:
                ws.close(1002, str(exc)[:100])
            finally:
                ws.closed = True

        threading.Thread(target=reader, daemon=True).start()

        try:
            while not ws.closed:
                with STATE_LOCK:
                    payload = json.dumps({"type": "state", "data": STATE},
                                         ensure_ascii=False)
                ws.send_text(payload)
                time.sleep(1)
        except wsproto.ClosedError:
            pass                                      # 브라우저가 탭을 닫음 — 정상
        finally:
            ws.close()

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                with STATE_LOCK:
                    payload = json.dumps(STATE, ensure_ascii=False)
                self.wfile.write(f"data: {payload}\n\n".encode())
                self.wfile.flush()
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError):
            pass                                      # 브라우저가 탭을 닫은 경우 — 정상

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(STATIC_DIR, rel))
        # 디렉터리 탈출 방지
        if not target.startswith(STATIC_DIR) or not os.path.isfile(target):
            target = os.path.join(STATIC_DIR, "index.html")   # SPA 폴백
        if not os.path.isfile(target):
            return self._json({"error": "static 빌드 결과가 없습니다"}, 404)

        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json; charset=utf-8",
        }.get(os.path.splitext(target)[1], "application/octet-stream")

        with open(target, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--host", default="127.0.0.1",
                    help="기본은 루프백. 터널로만 노출하므로 외부 바인딩은 하지 않는다")
    args = ap.parse_args()

    for fn in (collect_tegrastats, collect_slow, collect_ros_topics,
               collect_scan_hz, collect_esp32):
        threading.Thread(target=fn, name=fn.__name__, daemon=True).start()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"listening on http://{args.host}:{args.port}")
    print("  GET /api/state   스냅샷")
    print("  GET /api/stream  SSE (1초 간격)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
