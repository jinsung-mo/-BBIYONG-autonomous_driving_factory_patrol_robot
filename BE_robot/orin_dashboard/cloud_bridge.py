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
import inspect
import json
import os
from pathlib import Path
import sys
import time

from mapping_orchestrator import MappingOrchestrator
from navigation_orchestrator import NavigationOrchestrator
from event_clip_pipeline import EventClipPipeline, MultipartVideoUploader
from h264_protocol import decode_packet

# websockets 는 pip 의존성이다. 순수 매핑 함수(테스트 대상)는 이것 없이도
# import 되도록 지연 처리한다 — 개발 PC 에서 로직만 테스트할 수 있게.
try:
    import websockets
except ImportError:
    websockets = None


def websocket_auth_kwargs(connect_callable=None):
    """Return the robot-token header for old and new websockets releases."""
    token = (
        os.environ.get("ORINCAR_ROBOT_TOKEN")
        or os.environ.get("BBIYONG_ROBOT_UPLOAD_TOKEN")
    )
    if not token:
        return {}
    connect_callable = connect_callable or websockets.connect
    try:
        parameters = inspect.signature(connect_callable).parameters
    except (TypeError, ValueError):
        parameters = {}
    header_argument = (
        "additional_headers" if "additional_headers" in parameters else "extra_headers"
    )
    return {header_argument: {"X-Robot-Token": token}}

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
H264_FRAME_FILE = os.environ.get(
    "ORINCAR_H264_FRAME_FILE", "/dev/shm/orincar_h264.bin"
)
# 🆕 클라우드 링크 하트비트 (S15P11E101-657) — 이 브리지가 **쓰기만** 한다.
#    로컬 대시보드(server.py)가 "지금 클라우드 제어가 살아 있는가"를 판정할 유일한 근거다.
#    🔑 왜 `alive` 불린이 아니라 **타임스탬프**인가: 프로세스가 죽으면 스스로
#       `alive=false` 를 쓸 기회가 없다. 마지막 `true` 가 파일에 영원히 남고,
#       읽는 쪽은 계속 "살아 있다"고 믿어 **로봇이 영구히 잠긴다.**
#       타임스탬프는 아무도 갱신하지 않으면 스스로 낡으므로 읽는 쪽이 알아챈다.
#       (server.py 의 조종 리스 DRIVE_LEASE_S, cmd_mux 의 명령 타임아웃,
#        펌웨어 데드맨과 같은 패턴 — "살아 있음을 계속 증명해야 한다")
CLOUD_LINK_FILE = os.environ.get(
    "ORINCAR_CLOUD_LINK_FILE", "/tmp/orincar_cloud_link.json"
)

# 🔑 STOMP 는 지난 메시지를 새 구독자에게 재전송하지 않는다. 맵이 정지 상태여도
#    이 주기마다 한 번은 현재 맵을 다시 보내야, 도중에 접속한 대시보드가
#    빈 화면을 보지 않는다.
MAP_REEMIT_SEC = 10.0

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
                    latency_ms=None, estop="RELEASED", status_override=None):
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
    if status_override:
        packet["status"] = status_override
    packet["estop"] = estop
    return packet


def select_mission_status(mapping_status, navigation_status):
    """Mapping retains backend-compatible telemetry precedence."""
    return mapping_status or navigation_status


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

    if command in ("START_MAPPING", "STOP_MAPPING", "SAVE_MAP"):
        return "mapping", cmd

    if command in ("SET_PATROL_ROUTE", "SET_MODE", "NAVIGATE"):
        return "navigation", cmd

    if command == "EVENT_SAVED":
        return "event_saved", cmd

    return "bad", f"알 수 없는 command: {cmd.get('command')}"


def atomic_write(path, payload):
    # 🔑 [2026-08-04] 임시파일 이름에 PID 를 넣는다. 종전에는 프로세스마다 같은
    #    "<path>.tmp" 를 써서, 브리지가 실수로 두 개 뜨면 한쪽이 rename 한 뒤
    #    다른 쪽의 os.replace 가 ENOENT 로 계속 실패했다(하트비트가 통째로 죽음).
    #    실제로 발생했다 — 2026-08-04 03:22.
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as file:
        json.dump(payload, file)
    os.replace(tmp, path)


def write_cloud_link(alive, robot_id, latency_ms=None):
    """클라우드 링크 상태를 파일로 남긴다 (S15P11E101-657).

    읽는 쪽 계약: `ts` 가 얼마나 낡았는지로 판정한다. `alive` 는 보조 신호일 뿐
    이며, **파일이 없거나 `ts` 가 낡았으면 링크가 죽은 것으로 본다.**
    브리지가 크래시하면 `alive=False` 를 남길 기회조차 없기 때문이다.

    기록 실패는 치명적이지 않다 — 파일이 낡으면 읽는 쪽이 알아서 로컬로 넘어간다.
    그래서 예외를 삼키되 조용히 넘기지는 않는다(로그는 남긴다).
    """
    try:
        atomic_write(CLOUD_LINK_FILE, {
            "alive": bool(alive),
            "ts": time.time(),
            "robot_id": robot_id,
            "latency_ms": round(latency_ms, 1) if latency_ms is not None else None,
        })
    except OSError as exc:
        print(f"[link] 하트비트 기록 실패: {exc}", flush=True)


# ─────────────────────────────────────────────────────────────
# 비동기 I/O — 위의 순수 함수들을 소켓·파일·타이머에 연결한다
# ─────────────────────────────────────────────────────────────
class Bridge:
    def __init__(self, args):
        self.url = args.server_url
        self.robot_id = args.robot_id
        self.telemetry_period = 1.0 / args.telemetry_hz
        self.video_period = 1.0 / args.video_hz
        self.video_transport = getattr(args, "video_transport", "jpeg")
        self.h264_period = 1.0 / getattr(args, "h264_video_hz", 15.0)
        self.h264_frame_file = str(
            getattr(args, "h264_frame_file", H264_FRAME_FILE)
        )
        # 🆕 지도·자세 송신 (S15P11E101-660). hz 가 0 이면 끈다.
        self.map_enabled = getattr(args, "map_hz", 0.0) > 0
        self.map_period = (1.0 / args.map_hz) if self.map_enabled else None
        self.map_seq_sent = None
        self.nav_enabled = getattr(args, "nav_hz", 0.0) > 0
        self.nav_period = (1.0 / args.nav_hz) if self.nav_enabled else None
        self.fire = FireConfirmer()
        self.estop = "RELEASED"
        self.video_seq = 0
        self.mapping = None
        self.drive_file = str(getattr(args, "manual_drive_file", DRIVE_FILE))
        self.event_clips = None
        if bool(getattr(args, "event_clip_enabled", True)):
            self.event_clips = EventClipPipeline(
                robot_id=self.robot_id,
                state_file=getattr(
                    args,
                    "event_clip_state_file",
                    "~/.local/state/bbiyong/event_clips.json",
                ),
                manifest_file=getattr(
                    args,
                    "blackbox_manifest_file",
                    "~/.local/state/bbiyong/blackbox/manifest.json",
                ),
                uploader=MultipartVideoUploader(
                    upload_url=getattr(
                        args,
                        "video_upload_url",
                        "https://i15e101.p.ssafy.io/api/videos/upload",
                    ),
                    token=os.environ.get("BBIYONG_ROBOT_UPLOAD_TOKEN"),
                    timeout=getattr(args, "video_upload_timeout", 60.0),
                ),
                clip_wait_seconds=getattr(args, "event_clip_wait_seconds", 20.0),
            )
        legacy_navigation = bool(getattr(args, "navigation_enabled", False))
        self.backend_control_enabled = bool(
            getattr(args, "backend_control_enabled", legacy_navigation)
        )
        self.one_off_navigation_enabled = bool(
            getattr(args, "one_off_navigation_enabled", legacy_navigation)
        )
        self.patrol_enabled = bool(
            getattr(args, "patrol_enabled", legacy_navigation)
        )
        self.patrol_loop_enabled = bool(
            getattr(args, "patrol_loop_enabled", legacy_navigation)
        )
        if getattr(args, "mapping_enabled", False):
            self.mapping = MappingOrchestrator(
                robot_id=self.robot_id,
                upload_url=args.mapping_upload_url,
                token=os.environ.get("BBIYONG_ROBOT_UPLOAD_TOKEN"),
                map_dir=args.mapping_dir,
                state_file=args.mapping_state_file,
                launch_command=args.mapping_launch_command,
                save_command=args.mapping_save_command,
                upload_timeout=args.mapping_upload_timeout,
            )
        # Always create the control authority so backend ESTOP and bridge
        # restart remain fail-safe even while patrol/navigation is feature-gated.
        self.navigation = NavigationOrchestrator(
            robot_id=self.robot_id,
            route_file=getattr(
                args,
                "patrol_route_file",
                "~/.local/state/bbiyong/patrol_route.json",
            ),
            state_file=getattr(
                args,
                "navigation_state_file",
                "~/.local/state/bbiyong/navigation.json",
            ),
            control_file=getattr(
                args, "control_state_file", "/tmp/bbiyong_control.json"
            ),
            drive_file=self.drive_file,
            scouting_state_file=getattr(
                args,
                "scouting_state_file",
                "/tmp/bbiyong_scouting_session.json",
            ),
            patrol_command=getattr(args, "patrol_command", None),
            navigate_command=getattr(args, "navigate_command", None),
            patrol_loop=self.patrol_loop_enabled,
            handoff_settle_seconds=getattr(
                args, "control_handoff_settle_seconds", 0.15
            ),
            process_stop_timeout=getattr(args, "navigation_stop_timeout", 3.0),
        )
        if self.mapping:
            self.mapping.motion_stop = self.navigation.request_emergency_stop

    def _mapping_active(self):
        return self.mapping is not None and self.mapping.state in self.mapping.ACTIVE

    def _navigation_capability(self, command):
        kind = str(command.get("command") or "").upper()
        if kind == "NAVIGATE":
            return self.one_off_navigation_enabled, "one-off navigation"
        if kind == "SET_PATROL_ROUTE":
            return self.patrol_enabled, "patrol"
        if kind == "SET_MODE":
            mode = str(command.get("mode") or "").strip().lower()
            if mode == "disabled":
                return True, "safety disable"
            if mode == "autonomy":
                return self.patrol_enabled, "patrol"
            return self.backend_control_enabled, "backend control"
        return False, "navigation"

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

            mapping_status = self.mapping.telemetry_status if self.mapping else None
            navigation_status = (
                self.navigation.telemetry_status if self.navigation else None
            )
            effective_estop = (
                "ENGAGED" if self.navigation.estop_engaged else "RELEASED"
            )
            packet = build_telemetry(
                self.robot_id, nav_live, drive_status, cam, now,
                latency_ms=latency_ms, estop=effective_estop,
                status_override=select_mission_status(
                    mapping_status, navigation_status
                ),
            )
            await ws.send(json.dumps(packet))

            if self.mapping:
                completion = self.mapping.peek_completion_event()
                if completion:
                    await ws.send(json.dumps(completion))
                    self.mapping.mark_completion_event_sent()

            emit, confidence = self.fire.update(cam if fresh(cam, now) else None, now)
            if emit:
                await ws.send(json.dumps(
                    build_fire(self.robot_id, confidence, nav_live, now)))
                if self.event_clips:
                    try:
                        self.event_clips.note_event("FIRE", now)
                    except OSError as exc:
                        print(
                            f"[event-clip] failed to persist fire timestamp: {exc}",
                            flush=True,
                        )
                print(f"[fire] EVENT_FIRE 송신 conf={confidence:.2f}", flush=True)

            # 🆕 하트비트 — 텔레메트리를 **실제로 보낸 뒤에** 찍는다.
            #    send 가 실패하면 여기 못 오고 파일이 낡는다 = 링크 단절로 읽힌다.
            write_cloud_link(True, self.robot_id, latency_ms)

            await asyncio.sleep(self.telemetry_period)

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

    async def video_sender(self, ws):
        """FRONT 영상 루프. 텔레메트리와 주기를 분리해 대역폭을 따로 조절한다."""
        last_stamp = None
        while True:
            now = time.time()
            cam = read_json(CAM_FILE)
            if fresh(cam, now) and cam.get("t") != last_stamp:
                last_stamp = cam.get("t")
                self.video_seq += 1
                frame = build_video(self.robot_id, cam, self.video_seq)
                if frame:
                    await ws.send(json.dumps(frame))
            await asyncio.sleep(self.video_period)

    async def h264_video_sender(self, ws):
        """Forward each validated H.264 access unit once as a binary WS frame."""
        last_identity = None
        active_stream = None
        keyframe_seen = False
        fallback_cam_stamp = None
        last_error_log = 0.0
        while True:
            try:
                payload = Path(self.h264_frame_file).read_bytes()
                packet = decode_packet(payload)
                if packet.robot_id != self.robot_id:
                    raise ValueError("H.264 packet robot_id does not match bridge")
                if abs(time.time() * 1000 - packet.timestamp_ms) > 2_000:
                    raise ValueError("H.264 packet is stale")
                identity = (packet.stream_id, packet.sequence)
                if packet.stream_id != active_stream:
                    active_stream = packet.stream_id
                    keyframe_seen = False
                    last_identity = None
                if identity != last_identity:
                    last_identity = identity
                    if packet.keyframe:
                        keyframe_seen = True
                    if keyframe_seen:
                        await ws.send(payload)
            except (OSError, ValueError) as exc:
                cam = read_json(CAM_FILE)
                now = time.time()
                if fresh(cam, now) and cam.get("t") != fallback_cam_stamp:
                    fallback_cam_stamp = cam.get("t")
                    self.video_seq += 1
                    frame = build_video(self.robot_id, cam, self.video_seq)
                    if frame:
                        await ws.send(json.dumps(frame))
                if now - last_error_log >= 10.0:
                    last_error_log = now
                    print(f"[video:h264] waiting for valid frame: {exc}", flush=True)
            await asyncio.sleep(self.h264_period)

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
                command = (cmd.get("command") or "").upper()
                if command == "DRIVE" and not self.backend_control_enabled:
                    print(
                        "[recv] DRIVE rejected: backend control is disabled",
                        flush=True,
                    )
                    continue
                if command == "DRIVE" and not self.navigation.manual_control_allowed:
                    # ESTOP and mode transitions atomically disarm the manual file.
                    # Never let a later or queued DRIVE packet re-arm it.
                    state = self.navigation.state.value
                    print(
                        f"[recv] DRIVE rejected: manual control is unavailable "
                        f"(state={state}, estop={self.navigation.estop_engaged})",
                        flush=True,
                    )
                    continue
                try:
                    atomic_write(self.drive_file, payload)
                    self.estop = estop
                    print(f"[recv] {cmd.get('command')} → drive.json {payload}",
                          flush=True)
                except OSError as exc:
                    print(f"[recv] drive.json 쓰기 실패: {exc}", flush=True)
                if command == "ESTOP":
                    _, reason = await self.navigation.emergency_stop()
                    print(f"[recv] navigation ESTOP: {reason}", flush=True)
                    if self._mapping_active():
                        _, reason = await self.mapping.stop()
                        print(f"[recv] mapping ESTOP: {reason}", flush=True)
            elif action == "mapping":
                if not self.mapping:
                    print("[recv] mapping command rejected: mapping is disabled",
                          flush=True)
                    continue
                mapping_command = (rest[0].get("command") or "").upper()
                if mapping_command == "START_MAPPING":
                    prepared, reason = await self.navigation.prepare_for_mapping()
                    if not prepared:
                        print(
                            f"[recv] mapping rejected: navigation preemption failed: {reason}",
                            flush=True,
                        )
                        continue
                accepted, reason = await self.mapping.handle_command(rest[0])
                if accepted and mapping_command == "START_MAPPING":
                    self.navigation.enable_mapping_autonomy()
                outcome = "accepted" if accepted else "rejected"
                print(f"[recv] mapping {outcome}: {reason}", flush=True)
            elif action == "navigation":
                enabled, capability = self._navigation_capability(rest[0])
                if not enabled:
                    print(
                        f"[recv] navigation command rejected: {capability} is disabled",
                        flush=True,
                    )
                    continue
                navigation_command = (rest[0].get("command") or "").upper()
                mode = str(rest[0].get("mode") or "").lower()
                if self._mapping_active() and navigation_command != "SET_PATROL_ROUTE":
                    if navigation_command == "SET_MODE" and mode in {
                        "manual", "disabled"
                    }:
                        await self.mapping.stop()
                    else:
                        print(
                            "[recv] navigation rejected: mapping is active",
                            flush=True,
                        )
                        continue
                accepted, reason = await self.navigation.handle_command(rest[0])
                outcome = "accepted" if accepted else "rejected"
                print(f"[recv] navigation {outcome}: {reason}", flush=True)
            elif action == "event_saved":
                if not self.event_clips:
                    print("[recv] EVENT_SAVED ignored: event clips are disabled", flush=True)
                    continue
                try:
                    created = self.event_clips.enqueue(rest[0], time.time())
                except (OSError, ValueError) as exc:
                    print(f"[recv] EVENT_SAVED rejected: {exc}", flush=True)
                    continue
                outcome = "queued" if created else "duplicate"
                print(
                    f"[recv] EVENT_SAVED {outcome}: eventId={rest[0].get('eventId')}",
                    flush=True,
                )
            else:
                print(f"[recv] {action}: {rest[0]}", flush=True)

    async def run_once(self):
        # ping_interval/timeout 으로 죽은 연결을 빨리 감지하고 latency 를 얻는다.
        async with websockets.connect(
            self.url,
            ping_interval=10,
            ping_timeout=10,
            max_size=None,
            **websocket_auth_kwargs(),
        ) as ws:
            await ws.send(json.dumps(build_register(self.robot_id)))
            print(f"[conn] 접속·REGISTER 완료 → {self.url} (robot_id={self.robot_id})",
                  flush=True)
            # 재접속하면 서버·구독자가 맵을 잊었을 수 있다. 한 번 다시 보낸다.
            self.map_seq_sent = None
            tasks = [self.sender(ws), self.receiver(ws)]
            if self.map_enabled:
                tasks.append(self.map_sender(ws))
            if self.nav_enabled:
                tasks.append(self.nav_live_sender(ws))
            if self.video_transport == "h264":
                tasks.append(self.h264_video_sender(ws))
            elif self.video_transport == "jpeg":
                tasks.append(self.video_sender(ws))
            await asyncio.gather(*tasks)

    async def _connection_loop(self):
        """끊기면 백오프 후 재접속. 로봇은 계속 켜져 있고 서버가 재기동될 수 있다."""
        backoff = 1.0
        while True:
            try:
                await self.run_once()
            except (OSError, websockets.WebSocketException) as exc:
                print(f"[conn] 끊김: {exc} — {backoff:.0f}s 후 재접속", flush=True)
            else:
                print("[conn] 연결 종료 — 재접속", flush=True)
            # 🆕 끊긴 것을 **알 수 있을 때는** 즉시 알린다. 타임스탬프 만료를
            #    기다리는 것보다 빠르다. 단 이건 가속 장치일 뿐이고, 정본 판정은
            #    여전히 `ts` 신선도다(프로세스가 죽으면 여기 못 온다).
            write_cloud_link(False, self.robot_id)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)  # 최대 30초까지 지수 백오프

    async def run(self):
        if self.event_clips:
            await asyncio.gather(self._connection_loop(), self.event_clips.run())
        else:
            await self._connection_loop()


def _env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return bool(default)
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_args(argv=None):
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
    parser.add_argument("--video-hz", type=float, default=4.0)
    parser.add_argument(
        "--video-transport",
        choices=("jpeg", "h264", "off"),
        default=os.environ.get("ORINCAR_VIDEO_TRANSPORT", "jpeg"),
        help="jpeg compatibility mode, H.264 binary frames, or no live video",
    )
    parser.add_argument(
        "--h264-video-hz",
        type=float,
        default=float(os.environ.get("ORINCAR_H264_VIDEO_HZ", "15")),
    )
    parser.add_argument(
        "--map-hz",
        type=float,
        default=float(os.environ.get("ORINCAR_MAP_HZ", "1")),
        help="점유격자 맵 송신 주기(Hz). 0 이면 끈다. 실제 전송은 지도가 바뀔 때만",
    )
    parser.add_argument(
        "--nav-hz",
        type=float,
        default=float(os.environ.get("ORINCAR_NAV_HZ", "2")),
        help="자세·LiDAR 스캔(NAV_LIVE) 송신 주기(Hz). 0 이면 끈다",
    )
    parser.add_argument(
        "--h264-frame-file",
        default=os.environ.get("ORINCAR_H264_FRAME_FILE", H264_FRAME_FILE),
    )
    parser.add_argument(
        "--event-clip-enabled",
        action=argparse.BooleanOptionalAction,
        default=_env_flag("ORINCAR_EVENT_CLIP_ENABLED", True),
        help="durably upload blackbox clips after EVENT_SAVED",
    )
    parser.add_argument(
        "--video-upload-url",
        default=os.environ.get(
            "ORINCAR_VIDEO_UPLOAD_URL",
            "https://i15e101.p.ssafy.io/api/videos/upload",
        ),
    )
    parser.add_argument(
        "--video-upload-timeout",
        type=float,
        default=float(os.environ.get("ORINCAR_VIDEO_UPLOAD_TIMEOUT", "60")),
    )
    parser.add_argument(
        "--event-clip-state-file",
        default=os.environ.get(
            "ORINCAR_EVENT_CLIP_STATE_FILE",
            "~/.local/state/bbiyong/event_clips.json",
        ),
    )
    parser.add_argument(
        "--blackbox-manifest-file",
        default=os.environ.get(
            "ORINCAR_BLACKBOX_MANIFEST",
            "~/.local/state/bbiyong/blackbox/manifest.json",
        ),
    )
    parser.add_argument(
        "--event-clip-wait-seconds",
        type=float,
        default=float(os.environ.get("ORINCAR_EVENT_CLIP_WAIT_SECONDS", "20")),
    )
    parser.add_argument(
        "--mapping-enabled",
        action="store_true",
        default=os.environ.get("ORINCAR_MAPPING_ENABLED", "0") == "1",
        help="enable START_MAPPING/STOP_MAPPING/SAVE_MAP orchestration",
    )
    parser.add_argument(
        "--mapping-upload-url",
        default=os.environ.get(
            "ORINCAR_MAPPING_UPLOAD_URL",
            "https://i15e101.p.ssafy.io/api/maps/upload",
        ),
    )
    parser.add_argument(
        "--mapping-dir",
        default=os.environ.get("ORINCAR_MAPPING_DIR", "~/maps"),
    )
    parser.add_argument(
        "--mapping-state-file",
        default=os.environ.get(
            "ORINCAR_MAPPING_STATE_FILE", "~/.local/state/bbiyong/mapping.json"
        ),
    )
    parser.add_argument(
        "--mapping-launch-command",
        default=os.environ.get("ORINCAR_MAPPING_LAUNCH_COMMAND"),
        help="optional command template using {map_output}",
    )
    parser.add_argument(
        "--mapping-save-command",
        default=os.environ.get("ORINCAR_MAPPING_SAVE_COMMAND"),
        help="optional command template using {map_output}",
    )
    parser.add_argument(
        "--mapping-upload-timeout",
        type=float,
        default=float(os.environ.get("ORINCAR_MAPPING_UPLOAD_TIMEOUT", "20")),
    )
    legacy_navigation = _env_flag("ORINCAR_NAVIGATION_ENABLED")
    parser.add_argument(
        "--navigation-enabled",
        action="store_true",
        default=legacy_navigation,
        help="legacy master switch enabling every backend navigation capability",
    )
    parser.add_argument(
        "--backend-control-enabled",
        action="store_true",
        default=_env_flag("ORINCAR_BACKEND_CONTROL_ENABLED", legacy_navigation),
        help="enable backend DRIVE and SET_MODE manual commands",
    )
    parser.add_argument(
        "--one-off-navigation-enabled",
        action="store_true",
        default=_env_flag("ORINCAR_ONE_OFF_NAVIGATION_ENABLED", legacy_navigation),
        help="enable backend NAVIGATE goals",
    )
    parser.add_argument(
        "--patrol-enabled",
        action="store_true",
        default=_env_flag("ORINCAR_PATROL_ENABLED", legacy_navigation),
        help="enable SET_PATROL_ROUTE and SET_MODE autonomy",
    )
    parser.add_argument(
        "--patrol-loop-enabled",
        action="store_true",
        default=_env_flag("ORINCAR_PATROL_LOOP_ENABLED", legacy_navigation),
        help="allow patrol clients to repeat routes while autonomy remains active",
    )
    parser.add_argument(
        "--patrol-route-file",
        default=os.environ.get(
            "ORINCAR_PATROL_ROUTE_FILE",
            "~/.local/state/bbiyong/patrol_route.json",
        ),
    )
    parser.add_argument(
        "--navigation-state-file",
        default=os.environ.get(
            "ORINCAR_NAVIGATION_STATE_FILE",
            "~/.local/state/bbiyong/navigation.json",
        ),
    )
    parser.add_argument(
        "--control-state-file",
        default=os.environ.get(
            "ORINCAR_CONTROL_STATE_FILE", "/tmp/bbiyong_control.json"
        ),
    )
    parser.add_argument(
        "--manual-drive-file",
        default=os.environ.get("ORINCAR_DRIVE_FILE", DRIVE_FILE),
        help="atomic command file consumed by the maintained manual drive bridge",
    )
    parser.add_argument(
        "--control-handoff-settle-seconds",
        type=float,
        default=float(
            os.environ.get("ORINCAR_CONTROL_HANDOFF_SETTLE_SECONDS", "0.15")
        ),
        help="zero-command boundary before granting manual or autonomy control",
    )
    parser.add_argument(
        "--scouting-state-file",
        default=os.environ.get(
            "ORINCAR_SCOUTING_STATE_FILE", "/tmp/bbiyong_scouting_session.json"
        ),
    )
    parser.add_argument(
        "--patrol-command",
        default=os.environ.get(
            "ORINCAR_PATROL_COMMAND",
            "ros2 run bbiyong_bringup patrol_route --ros-args "
            "-p route_file:={route_file} -p loop_route:={patrol_loop}",
        ),
        help="optional command template using {route_file} and {patrol_loop}",
    )
    parser.add_argument(
        "--navigate-command",
        default=os.environ.get(
            "ORINCAR_NAVIGATE_COMMAND",
            "ros2 run bbiyong_bringup navigate_goal --ros-args "
            "-p x:={x} -p y:={y} -p yaw:={yaw}",
        ),
        help="optional command template using {x}, {y}, and {yaw}",
    )
    parser.add_argument(
        "--navigation-stop-timeout",
        type=float,
        default=float(os.environ.get("ORINCAR_NAVIGATION_STOP_TIMEOUT", "3")),
    )
    args = parser.parse_args(argv)
    # An explicit legacy CLI switch retains its historical all-capabilities
    # behavior. Environment-specific capability values remain independently
    # configurable when the legacy switch is not passed on the command line.
    if argv is not None:
        legacy_cli = "--navigation-enabled" in argv
    else:
        legacy_cli = "--navigation-enabled" in sys.argv[1:]
    if legacy_cli:
        args.backend_control_enabled = True
        args.one_off_navigation_enabled = True
        args.patrol_enabled = True
        args.patrol_loop_enabled = True
    return args


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
