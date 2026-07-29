#!/usr/bin/env python3
"""OrinCar → 관제 서버 연동 브리지 (파일 기반 1단계)

무엇을 하나
  로봇(Orin)이 관제 백엔드의 WebSocket 엔드포인트 `/ws/robot` 로 직접 접속해,
  로봇 상태·영상·화재 경보를 밀어 올리고(서버 계약: RobotPacket),
  서버가 내려주는 제어 명령(ControlCommand)을 받아 로컬 파일로 떨군다.

왜 독립 프로세스인가
  기존 orin_dashboard 는 ROS 노드가 /tmp json 파일로 데이터를 원자적으로 떨구고
  server.py 가 그 파일을 읽어 서빙하는 **파일 매개 디커플링** 구조다.
  이 브리지도 같은 파일을 소비/생산하기만 한다. ROS 나 server.py 에 손대지 않아
  각각을 따로 재시작해도 서로를 무너뜨리지 않는다.

무엇을 아직 안 하나 (2단계로 분리)
  SET_MODE / NAVIGATE / SAVE_MAP 은 파일 쓰기가 아니라 ROS 프로세스·액션
  오케스트레이션이 필요하다. 1단계에서는 수신 사실만 로그로 남기고 넘어간다.
  조용히 무시하지 않는 이유: "보냈는데 왜 안 되지" 로 헤매지 않게 하기 위해서다.

실행
  pip install websockets
  python3 cloud_bridge.py \
      --server-url wss://i15e101.p.ssafy.io/ws/robot \
      --robot-id orinka_01

의존성
  websockets (pip). 표준 lib 원칙의 예외 — 클라이언트 핸드셰이크·자동 ping/pong·
  재연결을 직접 구현하는 것보다 검증된 라이브러리를 쓰는 편이 안전하다고 판단.
"""

import argparse
import asyncio
import json
import os
import time

# websockets 는 pip 의존성이다. 순수 매핑 함수(테스트 대상)는 이것 없이도
# import 되도록 지연 처리한다 — 개발 PC 에서 로직만 테스트할 수 있게.
try:
    import websockets
except ImportError:
    websockets = None

# ─────────────────────────────────────────────────────────────
# 파일 경로 — server.py / nav_bridge.py / camera_node.py 와 동일 기본값
# (env 로 덮어쓸 수 있게 해 두면 테스트·다른 배치에서 재사용된다)
# ─────────────────────────────────────────────────────────────
NAV_LIVE_FILE = os.environ.get("ORINCAR_NAV_LIVE_FILE", "/tmp/orincar_nav_live.json")
NAV_MAP_FILE = os.environ.get("ORINCAR_NAV_MAP_FILE", "/tmp/orincar_nav_map.json")
CAM_FILE = os.environ.get("ORINCAR_CAM_FILE", "/tmp/orincar_cam.json")
DRIVE_FILE = os.environ.get("ORINCAR_DRIVE_FILE", "/tmp/orincar_drive.json")
DRIVE_STATUS_FILE = os.environ.get(
    "ORINCAR_DRIVE_STATUS", "/tmp/orincar_drive_status.json"
)

# 신선도 판정 — 이보다 오래된 파일은 "지금 값이 아님" 으로 보고 해당 필드를 비운다.
# 오래된 pose 를 살아있는 값처럼 올리면 관제 지도에 로봇이 유령처럼 남는다.
STALE_SEC = 5.0

# 화재 확정 — camera_node 와 같은 논리(N 프레임 중 M 회 이상). 브리지는 cam.json
# 을 폴링하므로 프레임 단위가 아니라 폴링 단위 확정이다. 그래도 단발 오탐을
# 한 번에 경보로 올리지 않기 위한 최소 안전장치다.
FIRE_N, FIRE_M = 5, 3
# 확정 상태가 지속되는 동안 재경보 간격. 매 폴링마다 EVENT_FIRE 를 쏘면
# 서버·대시보드가 중복 경보로 뒤덮인다.
FIRE_REEMIT_SEC = 10.0

# 맵이 변하지 않아도 이 간격마다 현재 맵을 한 번 재전송한다. STOMP 는 지난 메시지를
# 새 구독자에게 주지 않으므로, 대시보드가 도중 접속해도 곧 맵을 받게 하는 보완책.
MAP_REEMIT_SEC = 10.0


def read_json(path):
    """작은 json 을 읽어 dict 로 돌려준다. 없거나 깨졌으면 None.

    쓰는 쪽(nav_bridge/camera_node/server)이 tmp+os.replace 로 원자적 교체를
    하므로, 읽는 순간 반쪽짜리 파일을 만날 일은 없다. 그래도 방어적으로 잡는다.
    """
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except (OSError, ValueError):
        return None


def fresh(payload, now):
    """payload["t"] 가 STALE_SEC 이내면 True. t 가 없으면 신선하지 않다고 본다."""
    if not payload:
        return False
    stamp = payload.get("t")
    return stamp is not None and (now - float(stamp)) <= STALE_SEC


def infer_status(drive_status, now):
    """로봇에는 깔끔한 FSM 상태가 없다. drive_status 로 최선의 추정을 한다.

    서버 RobotPacket.status 는 AUTO_PATROL/APPROACH/VERIFY/MANUAL_CONTROL/MAPPING
    을 기대하지만 로봇이 실제로 노출하는 건 patrol 실행 여부와 teleop reason 뿐이다.
    - 순찰 중이면 AUTO_PATROL
    - 수동 주행 명령이 살아 움직이는 중이면 MANUAL_CONTROL
    - 그 외(판단 불가)는 None — 억지 매핑으로 관제를 오도하지 않는다.
    """
    if not drive_status:
        return None
    if drive_status.get("patrol_running"):
        return "AUTO_PATROL"
    v = abs(float(drive_status.get("v", 0.0)))
    w = abs(float(drive_status.get("w", 0.0)))
    if v > 1e-3 or w > 1e-3:
        return "MANUAL_CONTROL"
    return None


def build_register(robot_id):
    return {"source": "robot", "type": "REGISTER", "robot_id": robot_id}


def build_telemetry(robot_id, nav_live, drive_status, cam, now,
                    latency_ms=None, estop="RELEASED"):
    """RobotPacket TELEMETRY 를 조립한다. 없는 값은 아예 넣지 않는다.

    필드를 null 로 채우기보다 생략한다 — 서버 DTO 는 unknown 무시라서
    생략이 곧 "이 로봇은 이 값을 보고하지 않음" 을 명확히 표현한다.
    """
    packet = {"source": "robot", "type": "TELEMETRY", "robot_id": robot_id}

    if fresh(nav_live, now):
        pose = nav_live.get("pose")
        if pose and pose.get("frame"):
            packet["location"] = {
                "x": pose.get("x"),
                "y": pose.get("y"),
                "yaw": pose.get("yaw"),
            }

    if fresh(drive_status, now):
        packet["speed"] = drive_status.get("v")
        status = infer_status(drive_status, now)
        if status:
            packet["status"] = status

    if fresh(cam, now) and cam.get("det_fps") is not None:
        packet["inferenceFps"] = cam.get("det_fps")

    if latency_ms is not None:
        packet["commLatencyMs"] = int(latency_ms)
    packet["estop"] = estop
    return packet


def build_map(robot_id, nav_map):
    """nav_map.json(RLE snapshot)을 MAP 패킷으로. 없거나 sequence 없으면 None.

    nav_bridge 가 만든 원문({sequence, w, h, res, ox, oy, encoding, cells})에
    source/type/robot_id 만 얹어 그대로 보낸다. 서버는 이 원문을 해석하지 않고
    /topic/nav/{robot_id} 로 중계하며, RLE 디코드·렌더는 대시보드(FE)가 한다.
    """
    if not nav_map or nav_map.get("sequence") is None:
        return None
    return {**nav_map, "source": "robot", "type": "MAP", "robot_id": robot_id}


def build_nav_live(robot_id, nav_live):
    """nav_live.json 의 pose·scan 을 NAV_LIVE 패킷으로. 둘 다 없으면 None.

    맵(MAP)과 같은 /topic/nav 채널로 흘러 대시보드가 실시간 자세·LiDAR 스캔을
    지도 위에 겹쳐 그린다. scan 은 {angle_min, angle_inc, ranges} (nav_bridge 포맷).
    """
    if not nav_live:
        return None
    pose = nav_live.get("pose")
    scan = nav_live.get("scan")
    if pose is None and scan is None:
        return None
    packet = {
        "source": "robot",
        "type": "NAV_LIVE",
        "robot_id": robot_id,
        "t": nav_live.get("t"),
        "map_sequence": nav_live.get("map_sequence"),
    }
    if pose is not None:
        packet["pose"] = pose
    if scan is not None:
        packet["scan"] = scan
    return packet


def build_video(robot_id, cam, seq):
    """cam.json 의 FRONT(RGB) jpeg 를 VIDEO_FRAME 으로. 없으면 None.

    THERMAL 채널·maxTemp 는 로봇이 아직 생산하지 않는다 — 생기면 여기 채널을 늘린다.
    """
    if not cam or not cam.get("jpeg"):
        return None
    return {
        "source": "robot",
        "type": "VIDEO_FRAME",
        "robot_id": robot_id,
        "channel": "FRONT",
        "format": "jpeg",
        "data": cam["jpeg"],
        "seq": seq,
    }


class FireConfirmer:
    """cam.json 의 dets 에서 N/M 규칙으로 화재를 확정한다.

    update() 는 (경보를 지금 보낼지, confidence) 를 돌려준다. 상승엣지(막 확정됨)
    또는 확정 지속 중 재경보 간격이 지났을 때만 True 다.
    """

    def __init__(self, n=FIRE_N, m=FIRE_M, reemit_sec=FIRE_REEMIT_SEC):
        self.n = n
        self.m = m
        self.reemit_sec = reemit_sec
        self.history = []
        self.active = False
        self.last_emit = 0.0

    def update(self, cam, now):
        dets = (cam or {}).get("dets") or []
        fire_dets = [d for d in dets if d.get("cls") == 1]
        self.history.append(bool(fire_dets))
        if len(self.history) > self.n:
            self.history.pop(0)
        confirmed = sum(self.history) >= self.m

        confidence = max((float(d.get("conf", 0.0)) for d in fire_dets), default=0.0)

        emit = False
        if confirmed:
            rising = not self.active
            due = (now - self.last_emit) >= self.reemit_sec
            if rising or due:
                emit = True
                self.last_emit = now
        self.active = confirmed
        return emit, confidence


def build_fire(robot_id, confidence, nav_live, now):
    packet = {
        "source": "robot",
        "type": "EVENT_FIRE",
        "robot_id": robot_id,
        "confidence": round(confidence, 3),
    }
    if fresh(nav_live, now):
        pose = nav_live.get("pose")
        if pose and pose.get("frame"):
            packet["location"] = {
                "x": pose.get("x"),
                "y": pose.get("y"),
                "yaw": pose.get("yaw"),
            }
    return packet


def translate_command(cmd, now):
    """서버 ControlCommand → 로컬 동작.

    돌려주는 값:
      ("drive", {armed,v,w,ts}, estop)  drive.json 에 쓸 내용
      ("noop",  reason)                 1단계 미처리(로그만)
      ("bad",   reason)                 이해 못한 명령
    제어를 한 곳(teleop_node)이 최종 판단하도록, 여기서는 파일만 만든다.
    상한 클램프는 teleop_node 가 다시 건다(이중 방어) — 여기선 그대로 넘긴다.
    """
    command = (cmd.get("command") or "").upper()

    if command == "DRIVE":
        v = float(cmd.get("linear", 0.0) or 0.0)
        w = float(cmd.get("angular", 0.0) or 0.0)
        return "drive", {"armed": True, "v": v, "w": w, "ts": now}, "RELEASED"

    if command == "ESTOP":
        # fail-safe: active=true 만 의미 있다. 정지 + armed=false 로 떨군다.
        return "drive", {"armed": False, "v": 0.0, "w": 0.0, "ts": now}, "ENGAGED"

    if command in ("SET_MODE", "NAVIGATE", "SAVE_MAP"):
        return "noop", f"{command} 은 2단계(ROS 오케스트레이션)에서 처리 예정"

    return "bad", f"알 수 없는 command: {cmd.get('command')}"


def atomic_write(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as file:
        json.dump(payload, file)
    os.replace(tmp, path)


# ─────────────────────────────────────────────────────────────
# 비동기 I/O — 위의 순수 함수들을 소켓·파일·타이머에 연결한다
# ─────────────────────────────────────────────────────────────
class Bridge:
    def __init__(self, args):
        self.url = args.server_url
        self.robot_id = args.robot_id
        self.telemetry_period = 1.0 / args.telemetry_hz
        # video_hz <= 0 이면 영상 송신을 끈다. VIDEO_FRAME(base64 jpeg)은 크므로,
        # 서버 텍스트 버퍼 한도가 작을 때(1009 message too big) 임시로 꺼 두고
        # 텔레메트리·제어만 확인할 수 있게 한다.
        self.video_enabled = args.video_hz > 0
        self.video_period = (1.0 / args.video_hz) if self.video_enabled else None
        # 맵은 sequence 가 바뀔 때만 보낸다. 이 주기는 "얼마나 자주 확인하느냐"의 상한.
        self.map_enabled = args.map_hz > 0
        self.map_period = (1.0 / args.map_hz) if self.map_enabled else None
        self.map_seq_sent = None
        # 라이브 자세·LiDAR 스캔(NAV_LIVE). 고정 주기로 계속 보낸다(스캔은 매 프레임 바뀜).
        self.nav_enabled = args.nav_hz > 0
        self.nav_period = (1.0 / args.nav_hz) if self.nav_enabled else None
        self.fire = FireConfirmer()
        self.estop = "RELEASED"
        self.video_seq = 0

    async def sender(self, ws):
        """텔레메트리 + 화재 경보 루프."""
        while True:
            now = time.time()
            nav_live = read_json(NAV_LIVE_FILE)
            drive_status = read_json(DRIVE_STATUS_FILE)
            cam = read_json(CAM_FILE)

            latency_ms = None
            if ws.latency:  # websockets 가 ping/pong 으로 관측한 왕복(초)
                latency_ms = ws.latency * 1000.0

            packet = build_telemetry(
                self.robot_id, nav_live, drive_status, cam, now,
                latency_ms=latency_ms, estop=self.estop,
            )
            await ws.send(json.dumps(packet))

            emit, confidence = self.fire.update(cam if fresh(cam, now) else None, now)
            if emit:
                await ws.send(json.dumps(
                    build_fire(self.robot_id, confidence, nav_live, now)))
                print(f"[fire] EVENT_FIRE 송신 conf={confidence:.2f}", flush=True)

            await asyncio.sleep(self.telemetry_period)

    async def video_sender(self, ws):
        """FRONT 영상 루프. 텔레메트리와 주기를 분리해 대역폭을 따로 조절한다."""
        while True:
            now = time.time()
            cam = read_json(CAM_FILE)
            if fresh(cam, now):
                self.video_seq += 1
                frame = build_video(self.robot_id, cam, self.video_seq)
                if frame:
                    await ws.send(json.dumps(frame))
            await asyncio.sleep(self.video_period)

    async def map_sender(self, ws):
        """실시간 2D 점유격자 맵 송신. sequence 가 바뀐 경우에만 보낸다.

        nav_map.json 은 nav_bridge 가 지도 내용이 실제로 바뀔 때만 다시 쓰므로,
        sequence 비교로 중복 전송을 막는다(대역폭 절약).

        단, STOMP 는 지난 메시지를 새 구독자에게 재전송하지 않으므로, 맵이 정지
        상태여도 MAP_REEMIT_SEC 마다 한 번은 현재 맵을 다시 보낸다 — 대시보드가
        도중에 접속해도 곧 맵을 받게 하기 위한 초기 스냅샷 보완이다.
        """
        last_emit = 0.0
        while True:
            now = time.time()
            nav_map = read_json(NAV_MAP_FILE)
            packet = build_map(self.robot_id, nav_map)
            if packet is not None:
                changed = packet["sequence"] != self.map_seq_sent
                due = (now - last_emit) >= MAP_REEMIT_SEC
                if changed or due:
                    await ws.send(json.dumps(packet))
                    self.map_seq_sent = packet["sequence"]
                    last_emit = now
                    kind = "송신" if changed else "재전송(구독자 초기화용)"
                    print(f"[map] MAP {kind} sequence={packet['sequence']} "
                          f"({packet.get('w')}x{packet.get('h')})", flush=True)
            await asyncio.sleep(self.map_period)

    async def nav_live_sender(self, ws):
        """라이브 자세·LiDAR 스캔 송신 (NAV_LIVE). 고정 주기."""
        while True:
            packet = build_nav_live(self.robot_id, read_json(NAV_LIVE_FILE))
            if packet is not None:
                await ws.send(json.dumps(packet))
            await asyncio.sleep(self.nav_period)

    async def receiver(self, ws):
        """서버 → 로봇 제어 명령 수신."""
        async for raw in ws:
            try:
                cmd = json.loads(raw)
            except ValueError:
                print(f"[recv] JSON 파싱 실패: {raw!r}", flush=True)
                continue

            action, *rest = translate_command(cmd, time.time())
            if action == "drive":
                payload, estop = rest
                try:
                    atomic_write(DRIVE_FILE, payload)
                    self.estop = estop
                    print(f"[recv] {cmd.get('command')} → drive.json {payload}",
                          flush=True)
                except OSError as exc:
                    print(f"[recv] drive.json 쓰기 실패: {exc}", flush=True)
            else:
                print(f"[recv] {action}: {rest[0]}", flush=True)

    async def run_once(self):
        # ping_interval/timeout 으로 죽은 연결을 빨리 감지하고 latency 를 얻는다.
        async with websockets.connect(
            self.url, ping_interval=10, ping_timeout=10, max_size=None
        ) as ws:
            await ws.send(json.dumps(build_register(self.robot_id)))
            print(f"[conn] 접속·REGISTER 완료 → {self.url} (robot_id={self.robot_id}, "
                  f"video={'on' if self.video_enabled else 'off'})", flush=True)
            tasks = [self.sender(ws), self.receiver(ws)]
            if self.video_enabled:
                tasks.append(self.video_sender(ws))
            if self.map_enabled:
                self.map_seq_sent = None  # 재접속 시 현재 맵을 한 번 다시 보낸다
                tasks.append(self.map_sender(ws))
            if self.nav_enabled:
                tasks.append(self.nav_live_sender(ws))
            await asyncio.gather(*tasks)

    async def run(self):
        """끊기면 백오프 후 재접속. 로봇은 계속 켜져 있고 서버가 재기동될 수 있다."""
        backoff = 1.0
        while True:
            try:
                await self.run_once()
            except (OSError, websockets.WebSocketException) as exc:
                print(f"[conn] 끊김: {exc} — {backoff:.0f}s 후 재접속", flush=True)
            else:
                print("[conn] 연결 종료 — 재접속", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)  # 최대 30초까지 지수 백오프


def parse_args():
    parser = argparse.ArgumentParser(description="OrinCar → 관제 서버 WS 브리지")
    parser.add_argument(
        "--server-url",
        default=os.environ.get(
            "ORINCAR_CLOUD_URL", "wss://i15e101.p.ssafy.io/ws/robot"
        ),
        help="관제 서버 WebSocket URL (기본 운영 도메인)",
    )
    parser.add_argument(
        "--robot-id",
        default=os.environ.get("ORINCAR_ROBOT_ID", "orinka_01"),
        help="서버 세션 등록에 쓸 로봇 식별자",
    )
    parser.add_argument("--telemetry-hz", type=float, default=2.0)
    parser.add_argument("--video-hz", type=float, default=4.0,
                        help="0 이하면 영상(VIDEO_FRAME) 송신 비활성화")
    parser.add_argument("--map-hz", type=float, default=1.0,
                        help="맵 파일 확인 주기(상한). 0 이하면 맵(MAP) 송신 비활성화")
    parser.add_argument("--nav-hz", type=float, default=3.0,
                        help="라이브 자세·스캔(NAV_LIVE) 송신 주기. 0 이하면 비활성화")
    return parser.parse_args()


def main():
    args = parse_args()
    if websockets is None:
        raise SystemExit("websockets 가 필요합니다: pip install websockets")
    bridge = Bridge(args)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
