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
  GET  /api/ir      🔴 구형 원문 그대로 흘려보내는 IR 프레임 — nav.html 전용, 손대지 않는다
  GET  /api/thermal 🆕 열화상(MLX90640) 32x24, °C 환산 + connected/age (index.html 용)
  GET  /api/drive   수동 조종 상태 (teleop_node.py 가 떨군 것)
                    🆕 servo_angle_sent 도 여기 얹힌다(카메라 틸트 되읽기 — 실측
                    서보 위치가 아니라 마지막 명령각. server.py SERVO_STATE_FILE 주석 참조)
  POST /api/drive   🔴 **수동 조종 명령 — 유일하게 로봇을 움직이는 경로**
  POST /api/power   🆕 출력 제한(duty_max) 0~100% — **제어권자만**
  POST /api/servo   🆕 카메라 틸트 각도(0~180, 절대값) — 제어권 무관, 누구나
  GET /*            static/ 아래 정적 파일
"""

import argparse
import json
import os
import re
import shutil
import struct                                  # 🆕 H.264 BBV1 헤더 peek (_h264_peek)
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
    "battery": {             # INA226 미배선/미연결이면 전부 None
        "connected": False,
        "volts": None, "percent": None,
    },
    "env": {                 # DHT11 미배선/미연결이면 전부 None
        "connected": False,
        "temp_c": None, "humidity_pct": None,
    },
    "errors": {},            # 수집기별 마지막 오류 메시지
}


# ─────────────────────────────────────────────────────────────
# 🆕 조종 제어권(리스) + 출력 제한
# ─────────────────────────────────────────────────────────────
# STATE 와 **별도 락**을 쓴다. STATE_LOCK 은 수집 스레드가 초당 수십 번 잡고
# WS/SSE 송신이 그 안에서 json.dumps 까지 한다. 10Hz 조종 POST 가 그 뒤에
# 줄을 서면 데드맨(0.4s)이 걸릴 수 있다 — 조종 경로는 짧은 전용 락으로 분리한다.
CTL_LOCK = threading.Lock()

# 🆕 [2026-08-04] 수동주행 무장 (S15P11E101-662).
#    control_state_bridge 가 읽는 파일이다. 이 파일의 mode·estop 이
#    cmd_mux 의 게이트를 결정한다 — 여기가 안 열리면 /cmd_vel/manual 로
#    무엇을 보내든 0 으로 막힌다.
CONTROL_FILE = os.environ.get("ORINCAR_CONTROL_FILE", "/tmp/bbiyong_control.json")
CONTROL_MODES = ("disabled", "manual", "autonomy")   # control_state_bridge 와 동일
CONTROL_WATCH_S = 0.5      # 재잠금 감시 주기
DRIVE_LEASE_S = 2.0        # 🔴 리스 2초. 조종은 10Hz(100ms)로 갱신되므로
                           #    2초면 20발을 연속으로 놓쳐야 만료된다 = 오탈취 없음.
                           #    동시에 브라우저를 그냥 닫아도 2초 뒤 자동 반납된다
                           #    (닫힘 통지는 못 받는다 — POST 기반이라 소켓이 없다).
                           #    더 짧으면 와이파이 한 번 끊길 때 조종권을 뺏기고,
                           #    더 길면 사고 뒤 다른 사람이 잡기까지 오래 기다린다.
# 🆕 [2026-08-04] H.264 라이브 영상 — camera_node 가 인코딩해 떨군 액세스 유닛을
#    /api/wsvideo 로 **가공 없이** 흘린다. 포맷은 h264_protocol.py(BBV1) 와 동일하며,
#    브라우저가 같은 헤더를 파싱해 WebCodecs 로 편다.
#    🔑 server.py 는 표준 라이브러리만 쓴다는 원칙을 지키려고 h264_protocol 을
#       import 하지 않고 헤더 앞부분만 struct 로 직접 읽는다(_h264_peek).
#       전체 검증은 브라우저가 한다 — 여기서 중복 판정하지 않는다.
H264_FRAME_FILE = os.environ.get("ORINCAR_H264_FRAME_FILE", "/dev/shm/orincar_h264.bin")
H264_POLL_S = 1.0 / 60.0   # 30fps 소스를 놓치지 않으려면 그 두 배로 본다
H264_STALE_MS = 2000       # cloud_bridge 의 판정과 같은 문턱


def _h264_peek(raw):
    """BBV1 헤더 앞부분만 읽어 (sequence, flags, 나이_ms) 를 돌려준다.

    전체 파싱을 안 하는 이유: server.py 는 표준 라이브러리만 쓴다(h264_protocol 은
    브리지·프런트 쪽 모듈이다). 여기서 필요한 건 **보낼지 말지** 판단할 세 값뿐이다.
    포맷: >4sBBHIQQIHHHH — magic(4) version(1) flags(1) header_size(2)
          stream_id(4) sequence(8) timestamp_ms(8) payload_size(4) ...
    """
    if len(raw) < 40 or raw[:4] != b"BBV1":
        raise ValueError("BBV1 헤더가 아니다")
    flags = raw[5]
    sequence, timestamp_ms = struct.unpack_from(">QQ", raw, 12)
    return sequence, flags, abs(time.time() * 1000 - timestamp_ms)


DEFAULT_POWER_PCT = 30     # base_relog.sh / stack_up.sh 의 -p duty_max:=30.0 과 같은 값.
                           # 콜드 부팅 기본값과 서버 기본값을 일부러 일치시킨다.
CTL = {
    "power_pct": DEFAULT_POWER_PCT,
    "drive_owner": None,       # 조종권을 쥔 client_id (원문)
    "owner_expires": 0.0,      # epoch 초. 이 시각이 지나면 자동 반납
    "owner_since": 0.0,        # 현재 소유자가 잡기 시작한 시각
    # 🆕 이 대시보드가 무장시켰는가 (S15P11E101-662).
    #    재잠금 감시자가 **우리가 건 것만** 되돌리게 하는 표식이다.
    "armed_by_local": False,
}
# esp32_base_node.py 가 1Hz 로 읽어 펌웨어에 `kx<pct>` 로 밀어 넣는다.
# 프로세스 간 결합을 파일 하나로 끝낸다 — server.py 는 ROS 를 모른다.
POWER_FILE = os.environ.get("ORINCAR_POWER_FILE", "/tmp/orincar_power.json")
# 🆕 되읽기 — esp32_base_node 가 펌웨어 `k?` 회신에서 뽑아 떨구는 **실제** duty_max.
#    🔴 왜 필요한가: CTL["power_pct"] 는 이 프로세스가 기억하는 **명령값**이지
#       펌웨어에 물어본 결과가 아니다. esp32_base_node 가 죽어 있으면
#       POWER_FILE 은 갱신되는데 펌웨어는 못 받는다 — 그런데 지금까지 화면은
#       새 값을 그대로 표시했다. **로봇은 옛 값으로 달리는데 화면은 거짓말을 한다.**
#       그 한 방향 신뢰를 끊으려고 반대 방향 파일을 하나 더 읽는다.
POWER_ACK_FILE = os.environ.get("ORINCAR_POWER_ACK_FILE",
                                "/tmp/orincar_power_ack.json")
SERVO_FILE = os.environ.get("ORINCAR_SERVO_FILE", "/tmp/orincar_servo.json")
# 🆕 서보 상태 되읽기 — esp32_base_node.py 가 SERVO_FILE 과 **반대 방향**으로 쓰는 파일.
#    SERVO_FILE       = 대시보드 → 노드 (명령: "몇 도로 가라")
#    SERVO_STATE_FILE = 노드 → 대시보드 (상태: "마지막으로 실제 시리얼에 내보낸 각도")
#    🔴 SG90 류 RC 서보는 위치 피드백 배선이 없다 — 여기 담긴 값은 실측 축 각도가
#    아니라 "펌웨어에 전송 성공한 마지막 명령각"(servo_angle_sent)이다.
#    POWER_ACK_FILE 과 같은 관례 — 5Hz 로 갱신되므로(esp32_base_node.servo_tick)
#    신선도 문턱은 POWER_ACK_FRESH_S 보다 훨씬 짧게 잡는다.
SERVO_STATE_FILE = os.environ.get("ORINCAR_SERVO_STATE_FILE",
                                  "/tmp/orincar_servo_state.json")
SERVO_STATE_FRESH_S = 3.0   # 생산 주기 0.2s(5Hz) 의 15배 — 노드가 몇 틱만 밀려도
                            # 오탐하지 않을 만큼 넉넉하되, 죽은 채 몇 초씩 묵은
                            # 값을 "확인됨"으로 보여주지 않을 만큼 짧게.
# 🆕 esp32_base_node.py 가 DHT11/INA226 `E,` 라인을 파싱해 여기 떨군다
# ({"battery":{...}, "env":{...}}) — POWER_FILE·SERVO_FILE 과 같은 관례.
ENV_FILE = os.environ.get("ORINCAR_ENV_FILE", "/tmp/orincar_env.json")
# 회신을 몇 초까지 "살아 있는 것"으로 볼 것인가.
# 🔑 생산자가 5초 주기이므로 15초 = 3회 연속 실패해야 stale 로 떨어진다.
#    더 짧으면 스케줄 지터 한 번에 경고가 깜빡이고, 더 길면 노드가 죽은 뒤에도
#    한참 동안 화면이 "동기됨"이라고 안심시킨다 — 그게 바로 막으려는 상황이다.
POWER_ACK_FRESH_S = 15.0
# 🆕 열화상(MLX90640) — esp32_base_node.py 가 `IR,` 시리얼 라인을 파싱해
# {"width":32,"height":24,"pixels":[768개 int, 온도(°C)*10]} 로 떨군다.
# 이미 /api/ir 이 이 파일을 그대로 흘려보내지만(구형, nav.html 전용 — 손대지
# 않는다) 신선도·연결 여부를 서버가 판단해 주지 않는다. /api/thermal 은
# env/battery 와 같은 관례(연결 안 됨/오래됨을 프런트가 지어내지 않는다)로
# 새로 추가한다.
THERMAL_FILE = os.environ.get("ORINCAR_THERMAL_FILE", "/tmp/ir.json")
# 생산 주기 0.5s(speed_pid.ino lastMlxMs 간격, 최대 2Hz) — 6배인 3초를
# 넘기면 죽은 것으로 본다.
THERMAL_STALE_S = 3.0


def _mask(client_id):
    """소유자 표시용 짧은 식별자. 원문 client_id 를 그대로 뿌리지 않는다."""
    if not client_id:
        return None
    return str(client_id)[:4] + "…"


def _write_power_file(pct):
    """출력 제한을 파일로 떨군다.

    🔴 **원자적으로** 쓴다 — `.tmp` 에 다 쓴 뒤 os.replace.
       소비자(esp32_base_node)가 1Hz 로 읽는데, 같은 파일에 직접 쓰면
       반쯤 쓰인 JSON 을 읽는 순간이 반드시 생긴다. 그쪽은 그걸 '깨짐'으로
       보고 무시하도록 돼 있지만, 애초에 그 창을 만들지 않는 게 맞다.
       os.replace 는 같은 파일시스템에서 원자적이라 읽는 쪽은 옛 값 아니면
       새 값만 본다.
    """
    tmp = POWER_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"pct": int(pct), "ts": time.time()}, f)
    os.replace(tmp, POWER_FILE)


def _read_power_ack(now=None):
    """기기가 회신한 duty_max 를 읽는다. 표준 라이브러리만 쓴다.

    반환: (pct|None, age_s|None)
    🔑 파일이 없거나 깨졌으면 (None, None) — "모른다"이지 "0" 이 아니다.
       0 으로 돌려주면 화면이 '기기 0%' 라는 **틀린 사실**을 단언하게 된다.
    🔴 예외를 올리지 않는다. 이 함수는 GET /api/drive 경로에서 불리므로
       실패하면 조종 상태 조회 전체가 500 이 된다.
    """
    now = now or time.time()
    try:
        with open(POWER_ACK_FILE) as f:
            data = json.load(f)
        pct = int(round(float(data["pct"])))
        age = max(0.0, now - float(data["ts"]))
    except Exception:      # noqa: BLE001 — 없음/깨짐/권한/타입 전부 "모른다"
        return None, None
    return pct, age


def _read_servo_state(now=None):
    """esp32_base_node 가 마지막으로 시리얼에 내보낸 서보 각도를 읽는다.

    `_read_power_ack` 과 완전히 같은 모양이다 — 표준 라이브러리만 쓰고,
    파일이 없거나 깨졌으면 예외를 삼키고 (None, None) = "모른다"를 돌려준다.
    반환: (angle_deg|None, age_s|None)
    🔴 이 값은 실측 서보 위치가 **아니다**(위 SERVO_STATE_FILE 주석 참조).
       "0.0"을 기본값으로 돌려주면 화면이 "서보가 0도에 있다"는 틀린 사실을
       단언하게 되므로, 모르면 반드시 None 이어야 한다.
    """
    now = now or time.time()
    try:
        with open(SERVO_STATE_FILE) as f:
            data = json.load(f)
        angle = data.get("angle_sent")
        angle = None if angle is None else round(float(angle), 1)
        age = max(0.0, now - float(data["ts"]))
    except Exception:      # noqa: BLE001 — 없음/깨짐/권한/타입 전부 "모른다"
        return None, None
    return angle, age


def _read_control():
    """control 파일을 읽는다. 없거나 깨졌으면 None.

    🔴 이 파일이 없는 것은 정상이다 — /tmp 는 재부팅하면 사라지고,
       control_state_bridge 는 파일이 없으면 기본값(disabled+estop)을 유지한다.
       그래서 없을 때는 "잠긴 상태"로 해석해야 한다.
    """
    try:
        with open(CONTROL_FILE, encoding="utf-8") as f:
            payload = json.load(f)
        return {
            "seq": int(payload["seq"]),
            "mode": str(payload["mode"]).strip().lower(),
            "estop": bool(payload["estop"]),
            "updatedAt": float(payload["updatedAt"]),
        }
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _write_control(mode, estop):
    """control 파일을 원자적으로 교체한다. 쓴 내용을 돌려준다.

    🔑 seq 는 **파일을 읽어 +1** 한다. 이 파일에는 쓰는 주체가 셋 있고
       (control_state_bridge · control_command CLI · navigation_orchestrator)
       각자 자기 카운터를 들고 있어서, 자기 카운터를 쓰면 역전이 난다.
    🔑 임시파일 이름에 PID 를 넣는다. 같은 이름을 쓰면 두 프로세스가 동시에
       쓸 때 한쪽의 os.replace 가 ENOENT 로 실패한다 — cloud_bridge 에서
       2026-08-04 에 실제로 발생했다.
    """
    current = _read_control()
    payload = {
        "schemaVersion": 1,
        "seq": (current["seq"] + 1) if current else 1,
        "mode": mode,
        "estop": bool(estop),
        "updatedAt": time.time(),
    }
    tmp = f"{CONTROL_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, CONTROL_FILE)
    return payload


def _control_relock_watchdog():
    """조종 리스가 끊기면 무장을 되돌린다.

    브라우저를 그냥 닫거나 와이파이가 끊겨도 로봇이 무장된 채 남지 않게 한다.
    조종 명령 자체는 cmd_mux 의 0.5초 타임아웃으로 이미 멈추지만, **모드까지**
    되돌려야 다음 명령이 실수로 통과하지 않는다.

    🔴 우리가 무장한 경우에만 되돌린다(CTL["armed_by_local"]). 다른 주체가
       설정한 상태를 이 감시자가 멋대로 덮으면 그게 더 위험하다.
    """
    while True:
        time.sleep(CONTROL_WATCH_S)
        with CTL_LOCK:
            if not CTL.get("armed_by_local"):
                continue
            owner, exp = CTL["drive_owner"], CTL["owner_expires"]
            alive = owner is not None and time.time() < exp
            if alive:
                continue
            CTL["armed_by_local"] = False       # 락 안에서 먼저 내린다
        try:
            _write_control("disabled", True)
            print("[control] 조종 리스 만료 — 자동 재잠금(disabled+estop)", flush=True)
        except OSError as exc:
            # 🔴 조용히 넘기면 안 된다. 재잠금 실패는 로봇이 무장된 채
            #    남았을 수 있다는 뜻이다.
            print(f"[control] 🔴 자동 재잠금 실패 — 무장 상태일 수 있다: {exc}",
                  flush=True)


def _lease_acquire(client_id, now=None):
    """조종 리스를 잡거나 갱신한다. **선점(preempt) 불가.**

    반환: (허용여부, 거절정보)
      - 주인이 없거나 만료 → 요청자에게 부여
      - 주인 == 요청자      → 갱신 (now + DRIVE_LEASE_S)
      - 주인 != 요청자 & 유효 → 거절. 호출부가 409 를 낸다
    """
    now = now or time.time()
    with CTL_LOCK:
        owner, exp = CTL["drive_owner"], CTL["owner_expires"]
        free = owner is None or now >= exp
        if free or owner == client_id:
            if free and owner != client_id:
                CTL["owner_since"] = now         # 주인이 바뀐 시점만 갱신
            CTL["drive_owner"] = client_id
            CTL["owner_expires"] = now + DRIVE_LEASE_S
            return True, None
        return False, {
            "error": "locked",
            "owner": _mask(owner),
            "owner_since": CTL["owner_since"],
            "lease_left": round(exp - now, 2),
            "detail": "다른 사용자가 조종 중입니다",
        }


def _ctl_snapshot(client_id=None, now=None):
    """모든 시청자가 **같은 값**을 보도록 하는 공통 필드.

    GET /api/drive 응답에 얹는다. client_id 를 주면 `you_own` 이 붙는다 —
    마스킹된 owner 만으로는 브라우저가 "그게 나인지"를 알 수 없기 때문이다.
    """
    now = now or time.time()
    # 🔑 파일 읽기는 CTL_LOCK **밖**에서 한다. 이 락은 10Hz 조종 POST 가
    #    지나가는 길이라 디스크 I/O 를 넣으면 데드맨(0.4s)에 영향을 줄 수 있다.
    ack_pct, ack_age = _read_power_ack(now)
    # 🆕 현재 무장 상태. 새 엔드포인트를 만들지 않고 여기 얹는다 —
    #    index.html 이 이미 0.5초마다 GET /api/drive 를 폴링한다.
    #    파일이 없으면 잠긴 것으로 본다(control_state_bridge 의 기본값과 같다).
    control = _read_control()
    # 🆕 카메라 틸트 되읽기. 드라이브 화면이 이미 GET /api/drive 를 0.5초마다
    #    폴링하고 있어(index.html tick()), 새 엔드포인트 없이 여기 얹는 편이
    #    출력 제한 되읽기와 같은 지연 특성을 그대로 물려받는다.
    servo_angle, servo_age = _read_servo_state(now)
    with CTL_LOCK:
        owner, exp = CTL["drive_owner"], CTL["owner_expires"]
        active = owner is not None and now < exp
        commanded = CTL["power_pct"]
        # 🆕 동기 판정 — **두 조건이 모두** 필요하다.
        #    ① 값이 같다        : 명령 == 기기
        #    ② 회신이 신선하다  : 값이 같아도 회신이 늙었으면 그건 '동기'가
        #       아니라 '옛날에 동기였던 흔적'이다. 노드가 죽은 채 우연히
        #       같은 값이 남아 있는 경우를 참으로 만들면 안 된다.
        synced = (ack_pct is not None
                  and ack_age is not None
                  and ack_pct == commanded
                  and ack_age <= POWER_ACK_FRESH_S)
        # 🆕 카메라 틸트 신선도 — power_synced 와 달리 "명령==회신" 비교가 아니다.
        #    servo_angle 자체가 이미 "펌웨어에 보낸 마지막 값"이므로 비교 대상이
        #    없다. 여기서 판정하는 건 오직 "이 값이 최근 것인가"(노드 생존)뿐이다.
        servo_fresh = servo_age is not None and servo_age <= SERVO_STATE_FRESH_S
        return {
            "power_pct": commanded,
            # 🆕 무장 상태 (S15P11E101-662)
            "control_mode": control["mode"] if control else "disabled",
            "control_estop": control["estop"] if control else True,
            "control_armed": bool(
                control and control["mode"] != "disabled" and not control["estop"]),
            # 🆕 아래 3개는 **추가**다. 기존 필드는 하나도 건드리지 않았다 —
            #    index.html 이 t,v,w,reason,v_max,w_max,stop_m,patrol_running,
            #    power_pct,owner,owner_active,owner_since,lease_left,you_own 를 쓴다.
            "power_pct_actual": ack_pct,                       # int | null
            "power_ack_age": (round(ack_age, 2)
                              if ack_age is not None else None),  # float | null
            "power_synced": synced,                            # bool
            # 🆕 카메라 틸트 되읽기. servo_angle_sent 는 **실측 서보 위치가 아니라**
            #    esp32_base_node 가 마지막으로 시리얼에 내보낸 명령각이다
            #    (SG90 류는 위치 피드백 배선이 없다 — 위 SERVO_STATE_FILE 주석 참조).
            "servo_angle_sent": servo_angle,                    # float(deg, 0~180) | null
            "servo_angle_age": (round(servo_age, 2)
                                if servo_age is not None else None),  # float | null
            "servo_fresh": servo_fresh,                         # bool
            "owner": _mask(owner) if active else None,
            "owner_active": active,
            "owner_since": CTL["owner_since"] if active else None,
            "lease_left": round(max(0.0, exp - now), 2) if active else 0.0,
            "you_own": bool(active and client_id and owner == client_id),
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
            # -w 35 ≈ 3초(11.6Hz 기준) — 기본 창(10000개≈14.4분)이 너무 커서
            # 회전이 실제로 느려져도 대시보드 Hz가 거의 안 움직였다 (S15P11E101-639)
            ["ros2", "topic", "hz", "/scan", "-w", "35"],
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
# 수집기 5 — 배터리(INA226)·온습도(DHT11) — esp32_base_node.py 가 떨군 파일
# ─────────────────────────────────────────────────────────────
# 생산 주기 1Hz(speed_pid.ino ENV_MS). 5초 = 5회 연속 누락되면 죽은 것으로 본다.
# 🔑 mtime 으로 신선도를 판정한다 — esp32_base_node 가 죽거나 시리얼이 끊기면
#    ENV_FILE 갱신이 멈추는데, 그때도 옛 값을 계속 보여주면 "로봇은 안 재는데
#    화면은 옛 전압을 보여준다"는 거짓말이 된다(POWER_ACK_FRESH_S 와 같은 방침).
ENV_STALE_S = 5.0


def collect_env_battery():
    while True:
        try:
            age = time.time() - os.path.getmtime(ENV_FILE)
            if age > ENV_STALE_S:
                raise OSError(f"ENV_FILE stale ({age:.1f}s)")
            with open(ENV_FILE, encoding="utf-8") as f:
                data = json.load(f)
            battery = data.get("battery") or {}
            env = data.get("env") or {}
            _set(["battery"], {
                "connected": bool(battery.get("connected", False)),
                "volts": battery.get("volts"),
                "percent": battery.get("percent"),
            })
            _set(["env"], {
                "connected": bool(env.get("connected", False)),
                "temp_c": env.get("temp_c"),
                "humidity_pct": env.get("humidity_pct"),
            })
            with STATE_LOCK:
                STATE["errors"].pop("env", None)
        except Exception as exc:                      # noqa: BLE001 — 없음/깨짐/오래됨 전부 "모른다"
            _set(["battery"], {"connected": False, "volts": None, "percent": None})
            _set(["env"], {"connected": False, "temp_c": None, "humidity_pct": None})
            _set(["errors", "env"], str(exc))
        time.sleep(1)


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
# 수동 조종 — 대시보드가 여기에 명령을 쓰고 teleop_node.py 가 읽어 /cmd_vel 로 낸다.
# server.py 는 표준 라이브러리만 쓰므로 ROS 발행은 그 노드가 맡는다.
DRIVE_FILE = os.environ.get("ORINCAR_DRIVE_FILE", "/tmp/orincar_drive.json")
DRIVE_STATUS_FILE = os.environ.get("ORINCAR_DRIVE_STATUS", "/tmp/orincar_drive_status.json")
# 서버에서도 한 번 자른다. 최종 상한은 teleop_node 가 다시 건다(이중 방어).
# 🔴 **teleop_node.V_MAX 와 반드시 같이 올려야 한다.** 한쪽만 올리면 낮은 쪽이
#    이기고 아무 변화가 없다 — 2026-07-27 teleop 만 0.50 으로 올렸다가
#    여기서 0.15 로 잘려 "왜 최고속도가 그대로냐"로 헤맸다.
#    프런트(static/index.html)는 상태파일의 v_max 를 읽어 따라오므로 손댈 필요 없다.
DRIVE_V_MAX, DRIVE_W_MAX = 1.00, 0.60


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

    def _ir(self):
        try:
            with open("/tmp/ir.json", "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            return self._json({"error": "No IR data"}, 404)

    def _thermal(self):
        """열화상(MLX90640) 32x24 프레임 — env/battery 와 같은 연결/신선도 관례.

        THERMAL_FILE 픽셀값은 온도(°C)*10 의 int(펌웨어 `(int16_t)(mlxFrame[i]*10)`).
        여기서 실제 섭씨로 환산하고, 파일이 없거나 THERMAL_STALE_S 보다 오래됐으면
        connected:false + pixels:null 로 답한다 — 0으로 지어내지 않는다(프런트가
        "데이터 없음"과 "전부 0도"를 구분할 수 있게).
        """
        try:
            age = time.time() - os.path.getmtime(THERMAL_FILE)
        except OSError:
            return self._json({"connected": False, "width": 32, "height": 24,
                                "pixels": None, "age": None,
                                "error": "MLX90640 파일 없음"})
        try:
            with open(THERMAL_FILE, encoding="utf-8") as f:
                raw = json.load(f)
            pixels_raw = raw.get("pixels") or []
            w, h = raw.get("width", 32), raw.get("height", 24)
        except (OSError, ValueError) as exc:
            return self._json({"connected": False, "width": 32, "height": 24,
                                "pixels": None, "age": round(age, 2),
                                "error": str(exc)})
        if age > THERMAL_STALE_S or not pixels_raw:
            return self._json({"connected": False, "width": w, "height": h,
                                "pixels": None, "age": round(age, 2)})
        pixels_c = [round(v / 10.0, 1) for v in pixels_raw]
        return self._json({
            "connected": True,
            "width": w, "height": h,
            "pixels": pixels_c,
            "min": round(min(pixels_c), 1),
            "max": round(max(pixels_c), 1),
            "age": round(age, 2),
        })

    def do_GET(self):                                 # noqa: N802
        request = urlsplit(self.path)
        path = request.path

        if path == "/api/health":
            return self._json({"ok": True})

        if path == "/api/ir":
            return self._ir()

        if path == "/api/thermal":
            return self._thermal()

        if path == "/api/state":
            with STATE_LOCK:
                return self._json(json.loads(json.dumps(STATE)))

        if path == "/api/drive":
            # 조종 상태 조회 (teleop_node 가 쓴 것). 없으면 미실행이다.
            # 🆕 여기에 제어권·출력제한을 **얹기만** 한다.
            #    기존 필드(t,v,w,reason,v_max,w_max,stop_m,patrol_running)는
            #    index.html 이 전부 쓰므로 하나도 건드리지 않는다.
            client_id = (parse_qs(request.query).get("client_id") or [None])[0]
            extra = _ctl_snapshot(client_id)
            try:
                with open(DRIVE_STATUS_FILE) as f:
                    body = f.read()
            except OSError:
                # 🆕 503 본문에도 제어권 정보를 넣는다. teleop 이 죽어 있어도
                #    "누가 잡고 있는지"는 여전히 서버가 아는 사실이다.
                return self._json({"error": "teleop_node 가 실행 중이 아닙니다",
                                   "hint": "python3 teleop_node.py", **extra}, 503)
            try:
                merged = json.loads(body)
                if not isinstance(merged, dict):
                    raise ValueError("dict 가 아님")
                merged.update(extra)
                body = json.dumps(merged, ensure_ascii=False)
            except (ValueError, TypeError):
                # 파일이 깨졌으면 **원문 그대로** 흘려보낸다. 진단을 가리지 않는다.
                pass
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

        if path == "/api/wsvideo":
            return self._websocket_video()

        if path == "/api/stream":
            return self._sse()

        return self._static(path)

    def do_POST(self):                                # noqa: N802
        """수동 조종 명령. 파일로 떨구고 teleop_node.py 가 읽어 간다.

        🔴 이 엔드포인트만이 **물리 로봇을 움직인다.** 나머지는 전부 조회다.
           서버에서 상한을 자르고, teleop_node 가 데드맨·라이다 가드·순찰 충돌
           검사를 다시 한다. 방어를 한 곳에 몰지 않는다.
        """
        path = self.path.split("?")[0]
        if path not in ("/api/drive", "/api/power", "/api/servo", "/api/control"):
            return self._json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > 4096:
                return self._json({"error": "본문 크기가 이상합니다"}, 400)
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError) as exc:
            return self._json({"error": f"본문 파싱 실패: {exc}"}, 400)

        # client_id 가 없으면 "anon" 한 명으로 취급한다. curl 로 두드리는 구형
        # 호출을 400 으로 끊지 않으면서도, 익명끼리는 **서로 경쟁하지 않는다**
        # (각 요청에 새 id 를 붙이면 익명 요청이 자기 자신에게 409 를 낸다).
        client_id = str(data.get("client_id") or "anon")[:64]

        if path == "/api/power":
            return self._power(client_id, data)
            
        if path == "/api/control":
            return self._control(client_id, data)
        if path == "/api/servo":
            return self._servo(client_id, data)

        # ── 조종 리스 ───────────────────────────────────────────────
        # 🔴 거절이면 **파일에 쓰지 않는다.** 여기서 쓰면 남의 조종을 덮어써
        #    로봇이 두 사람 명령을 번갈아 받는다 — 배타 제어의 존재 이유가 사라진다.
        granted, deny = _lease_acquire(client_id)
        if not granted:
            return self._json(deny, 409)

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
                           "note": "상태는 GET /api/drive 로 따로 조회할 것",
                           **_ctl_snapshot(client_id)})

    def _control(self, client_id, data):
        """수동주행 무장/해제. **제어권자만.**

        조종·출력과 같은 리스를 쓴다. 별도 리스를 두면 "무장은 A, 조종은 B"
        같은 상태가 생겨, A 가 무장을 푸는 순간 B 의 주행이 끊긴다.
        """
        granted, deny = _lease_acquire(client_id)
        if not granted:
            return self._json(deny, 409)

        mode = str(data.get("mode", "")).strip().lower()
        if mode not in CONTROL_MODES:
            return self._json(
                {"error": f"mode 는 {list(CONTROL_MODES)} 중 하나여야 합니다"}, 400)
        estop = data.get("estop")
        if not isinstance(estop, bool):
            # 🔴 문자열 "false" 를 받아주지 않는다. 안전 플래그를 느슨하게
            #    파싱하면 오타가 무장으로 이어진다.
            return self._json({"error": "estop 은 true/false 여야 합니다"}, 400)
        if mode != "disabled" and estop:
            return self._json(
                {"error": "estop 이 걸린 채로는 disabled 외의 모드로 갈 수 없습니다"}, 400)

        try:
            written = _write_control(mode, estop)
        except OSError as exc:
            return self._json({"error": f"제어 파일 쓰기 실패: {exc}"}, 500)

        armed = (mode != "disabled") and not estop
        with CTL_LOCK:
            CTL["armed_by_local"] = armed
        print(f"[control] mode={mode} estop={estop} seq={written['seq']} "
              f"by={_mask(client_id)}", flush=True)
        return self._json({"ok": True, "accepted": written,
                           "note": "실제 반영은 GET /api/drive 의 control_* 로 확인할 것",
                           **_ctl_snapshot(client_id)})

    def _power(self, client_id, data):
        """🆕 출력 제한(펌웨어 duty_max) 설정. **제어권자만.**

        조종과 같은 리스를 쓴다. 아무도 안 잡고 있으면 요청자가 잡고(그래서
        조종 전에도 슬라이더를 쓸 수 있다), 남이 잡고 있으면 409 다.
        — 별도 리스를 두면 "조종은 A, 출력은 B" 같은 상태가 생겨
          A 가 달리는 도중 B 가 duty 를 0 으로 내릴 수 있다.
        """
        granted, deny = _lease_acquire(client_id)
        if not granted:
            return self._json(deny, 409)
        try:
            pct = int(round(float(data.get("pct"))))
        except (TypeError, ValueError):
            return self._json({"error": "pct 는 숫자여야 합니다"}, 400)
        pct = max(0, min(100, pct))          # 0~100 으로 잘라 넣는다

        with CTL_LOCK:
            changed = pct != CTL["power_pct"]
            CTL["power_pct"] = pct
        if changed:
            try:
                _write_power_file(pct)
            except OSError as exc:
                return self._json({"error": f"출력 파일 쓰기 실패: {exc}"}, 500)
        return self._json({"ok": True, "pct": pct, "changed": changed,
                           **_ctl_snapshot(client_id)})

    def _servo(self, client_id, data):
        """🆕 서보 각도 제어 API.

        🔑 이 POST 는 명령만 접수한다 — 로봇이 실제로 그 각도를 받았는지는
           **이 응답에 없다.** 되읽기(esp32_base_node 가 마지막으로 시리얼에
           내보낸 값)는 GET /api/drive 의 `servo_angle_sent`(+ `servo_angle_age`,
           `servo_fresh`)로 따로 조회한다 — `_ctl_snapshot`/`_read_servo_state` 참조.
        """
        # 🔴 종전 int() 는 IPM 거리추정을 못 쓰게 만든다 — 링크 레버비 0.66 을 곱해도
        #    카메라에서 0.66° 스텝이고, 그건 1 m 에서 7.9% 거리오차다
        #    (docs/단안깊이_조사_2026-08-02.md §3-2). 0.1도까지 받는다.
        #    ⚠️ 이 값은 esp32_base_node.servo_tick · speed_pid.ino `case 'c'` 와
        #    **세 곳이 같이** 소수점을 받아야 한다. 한 곳이라도 int 면 거기서 잘린다.
        #    정수를 보내던 기존 호출부(FE 각도 버튼 등)는 그대로 동작한다.
        try:
            angle = float(data.get("angle", 90))
        except (TypeError, ValueError):
            return self._json({"error": "angle must be a number"}, 400)
        angle = round(max(0.0, min(180.0, angle)), 1)
        
        tmp = SERVO_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"angle": angle, "ts": time.time()}, f)
            os.replace(tmp, SERVO_FILE)
        except OSError as exc:
            return self._json({"error": f"서보 제어 파일 쓰기 실패: {exc}"}, 500)
        return self._json({"ok": True, "angle": angle})

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

    def _websocket_video(self):
        """🆕 H.264 액세스 유닛을 **가공 없이** 바이너리 WS 프레임으로 흘린다.

        왜 별도 엔드포인트인가
            `/api/ws` 는 1Hz 상태 JSON 이다. 영상은 30Hz 바이너리라 주기도
            형식도 다르다. 한 소켓에 섞으면 상태 갱신이 영상에 밀린다.

        왜 재인코딩하지 않는가
            `camera_node` 가 이미 x264 로 인코딩해 `/dev/shm` 에 떨궈 뒀다.
            서버는 그 바이트를 **그대로** 넘기고 디코딩은 브라우저(WebCodecs)가
            한다. base64 로 감싸면 33% 커지는데, 30fps 에서는 매 프레임 반복된다.
            `cloud_bridge` 가 팀 백엔드에 하는 것과 같은 방식이다.

        키프레임을 기다리는 이유
            디코더는 SPS/PPS 와 IDR 없이는 아무것도 못 편다. 중간 P프레임부터
            보내면 브라우저가 조용히 깨진 화면을 그린다. `cloud_bridge` 의
            `h264_video_sender` 와 같은 규칙을 쓴다 — 첫 키프레임 전에는 안 보낸다.

        🔴 실패해도 조용히 죽지 않는다: 파일이 없거나 stale 이면 그냥 안 보낸다.
           프런트는 프레임이 안 오면 JPEG 경로로 폴백한다(index.html 의 토글).
        """
        if self.headers.get("Upgrade", "").lower() != "websocket":
            return self._json({"error": "Upgrade: websocket 헤더가 필요합니다"}, 400)
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._json({"error": "Sec-WebSocket-Key 가 없습니다"}, 400)

        self.wfile.write(wsproto.handshake_response(key))
        self.wfile.flush()
        self.close_connection = True
        ws = wsproto.WebSocket(self.connection, threading.Lock())

        def reader():                       # ping/close 처리 전용
            try:
                while not ws.closed:
                    ws.read()
            except (wsproto.ClosedError, OSError, wsproto.WebSocketError):
                pass
            finally:
                ws.closed = True

        threading.Thread(target=reader, daemon=True).start()

        last_seq = None
        keyframe_seen = False
        try:
            while not ws.closed:
                try:
                    raw = open(H264_FRAME_FILE, "rb").read()
                    seq, flags, fresh_ms = _h264_peek(raw)
                except (OSError, ValueError):
                    seq = None
                if seq is not None and seq != last_seq and fresh_ms <= H264_STALE_MS:
                    last_seq = seq
                    if flags & 0x01:                      # FLAG_KEYFRAME
                        keyframe_seen = True
                    if keyframe_seen:
                        ws.send_binary(raw)
                time.sleep(H264_POLL_S)
        except (wsproto.ClosedError, OSError):
            pass                                          # 탭을 닫음 — 정상
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

    # 🆕 기동하자마자 출력 제한 파일을 한 번 쓴다.
    #    esp32_base_node 와 **기동 순서에 무관**하게 값이 맞도록 하기 위해서다.
    #    노드가 먼저 떠 있으면 다음 1Hz 틱에서 이 값을 집어 펌웨어에 밀어 넣고,
    #    나중에 뜨면 첫 틱에서 집는다. 어느 쪽이든 화면과 펌웨어가 일치한다.
    try:
        _write_power_file(CTL["power_pct"])
        print(f"출력 제한 기본값 {CTL['power_pct']}% → {POWER_FILE}")
    except OSError as exc:
        print(f"출력 제한 파일 쓰기 실패(무시하고 계속): {exc}")

    for fn in (collect_tegrastats, collect_slow, collect_ros_topics,
               collect_scan_hz, collect_esp32, collect_env_battery,
               _control_relock_watchdog):
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
