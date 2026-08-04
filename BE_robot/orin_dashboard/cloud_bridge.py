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
import base64
import inspect
import json
import os
from pathlib import Path
import struct                                  # 🆕 열화상 PNG 인코딩 (build_thermal)
import sys
import time
import zlib                                     # 🆕 열화상 PNG IDAT 압축 — 표준 라이브러리, PIL 등 새 의존성 없음

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
# esp32_base_node.py 가 INA226 배터리 잔량을 떨구는 파일. server.py 의
# collect_env_battery() 와 같은 소스다 — 그쪽은 대시보드 로컬 표시용, 여기는
# 관제 서버(RobotPacket.battery)로 올리는 경로다.
ENV_FILE = os.environ.get("ORINCAR_ENV_FILE", "/tmp/orincar_env.json")
# 🆕 열화상(MLX90640) — server.py 의 THERMAL_FILE 과 같은 파일·같은 기본값.
# esp32_base_node.py 가 `IR,` 시리얼 라인을 파싱해 {"width":32,"height":24,
# "pixels":[768개 int, 온도(°C)*10]} 로 원자적 교체한다. "t" 필드가 없으므로
# (server.py 의 _thermal() 과 동일하게) 신선도는 **파일 mtime** 으로 판정한다 —
# 아래 fresh() 는 payload["t"] 를 기대하므로 이 파일에는 못 쓴다.
THERMAL_FILE = os.environ.get("ORINCAR_THERMAL_FILE", "/tmp/ir.json")
# server.py 의 THERMAL_STALE_S 와 같은 값 — 생산 주기(≈1Hz, S15P11E101-663/664/667
# 로 이미 조사된 하드웨어 제약) 의 3배. 더 짧으면 정상 지터에도 깜빡이고,
# 더 길면 mlx.getFrame() 이 죽은 뒤에도 옛 프레임을 계속 "연결됨"으로 보낸다.
THERMAL_STALE_S = 3.0
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
# 🆕 화재 경보 최소 신뢰도 `[사용자 지정 2026-08-04]` — 이 값 미만인 YOLO 탐지는
# 아예 "화재 프레임"으로 세지 않는다.
#   🔑 왜 M-of-N **앞**에 거는가: 뒤에 거는 방법(이력 중 최고 conf 가 60% 이상일 때만
#      확정)도 있지만, 그러면 30%짜리 프레임 5개 + 61%짜리 1개로도 확정된다 —
#      단발 스파이크를 막으라고 넣은 M-of-N 이 무력해진다. 앞에서 거르면
#      "60% 이상으로 본 프레임이 N 중 M 번" 이라는 두 조건이 모두 살아 있다.
#   ⚠️ 이것은 **알림 게이트**이지 판정 알고리즘이 아니다. camera_node.py 의 YOLO
#      판정(cls==1, fire_hist)은 손대지 않았다 — 로컬 대시보드는 여전히 저신뢰
#      탐지까지 다 본다. 여기서 막는 것은 관제 서버로 올라가는 EVENT_FIRE 뿐이다.
FIRE_MIN_CONF = 0.60

# ─────────────────────────────────────────────────────────────
# 🆕 과열 경보 (EVENT_OVERHEAT) — 카메라 YOLO 와 **완전히 독립된** 경로다.
#    화재 판정(FireConfirmer)은 cam.json 의 dets 만 보고, 이쪽은 THERMAL_FILE 의
#    열화상 그리드만 본다. 둘 중 하나만 떠도 경보가 나간다.
# ─────────────────────────────────────────────────────────────
# 발동 임계 온도 `[사용자 지정 2026-08-04]`. 실측으로 유도한 값이 아니라 사용자가
# 직접 준 운영 기준이다 — 임의로 바꾸지 말 것. 패킷의 `threshold` 로도 함께 실어
# 보내므로(서버가 튜닝 이력을 추적할 수 있게, 인터페이스 초안 §5.3) 나중에 값을
# 바꿔도 과거 이벤트가 어떤 기준에서 났는지 남는다.
OVERHEAT_TEMP_C = 100.0
# 과열 M-of-N. 화재의 5/3 과 **숫자는 다르지만 시간 창은 같게** 맞춘 값이다.
#   화재: 텔레메트리 2 Hz × 5 폴링 ≈ 2.5 초 창
#   과열: 열화상 ≈1 Hz × 3 프레임 ≈ 3 초 창  (하드웨어 주사율 -663/-664/-667)
# 같은 5/3 을 그대로 쓰면 과열만 5 초를 기다리게 된다 — 100°C 는 즉시성이 중요한
# 경보라 불필요하게 늦다.
#   🔑 디바운스가 필요한 이유: 판정 지표가 768 픽셀의 **max()** 다. 통계량 중
#      단일 불량 픽셀에 가장 취약한 값이라, 한 프레임 스파이크로 경보를 내면
#      오발동한다. 2/3 을 요구하면 비용은 ≈2 초 지연뿐이고, 진짜 과열은 그보다
#      훨씬 오래 지속된다.
OVERHEAT_N, OVERHEAT_M = 3, 2
# 재경보 간격 — 화재와 같은 값. 과열이 지속되는 동안 매 프레임 쏘면 관제가 묻힌다.
OVERHEAT_REEMIT_SEC = 10.0
# 경보에 필요한 **최소 고온 픽셀 수**.
#   🔑 왜 시간 디바운스(M-of-N)만으로는 부족한가: M-of-N 은 프레임마다 랜덤하게
#      튀는 노이즈를 막는다. 그러나 MLX90640 에서 흔한 **고착 불량 픽셀(stuck hot
#      pixel)** 은 매 프레임 똑같이 뜨겁게 나오므로 시간 디바운스를 그대로 통과한다.
#      둘은 막는 대상이 다르다 — 시간(랜덤 스파이크) + 공간(고착 픽셀) 이 모두 필요하다.
#      `[agy 외부검토 2026-08-04 지적사항]`
#   2 로 두는 근거: 불량 픽셀은 보통 고립된 1개다. "두 픽셀 이상이 동시에 뜨겁다"는
#      최소 조건만 걸면 고립 불량 픽셀은 확실히 걸러지고, 실제 100°C 열원은 32×24
#      화각에서 훨씬 넓게 잡히므로 놓칠 위험이 없다. 3×3 메디안 필터도 검토했으나
#      (agy 대안 2) 커널 크기라는 새 임의값이 필요하고 연산도 늘어 채택하지 않았다.
OVERHEAT_MIN_HOT_PIXELS = 2


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
                    latency_ms=None, estop="RELEASED", status_override=None,
                    env=None):
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

    # env.json 은 nav_live/drive_status/cam 과 달리 "t" 가 아니라 "ts" 를 쓴다
    # (esp32_base_node.py._handle_env_telemetry) — fresh() 를 그대로 못 쓴다.
    if env and env.get("ts") is not None and (now - float(env["ts"])) <= STALE_SEC:
        battery = env.get("battery") or {}
        if battery.get("connected") and battery.get("percent") is not None:
            packet["battery"] = battery.get("percent")

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

    THERMAL 채널은 build_thermal() 이 맡는다 (S15P11E101 열화상 관제 미표시 수정,
    2026-08-04) — 로봇은 이제 MLX90640 을 생산한다(server.py /api/thermal 로 실측
    확인됨). 아래는 그 채널의 구현이다.
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


# 🆕 열화상 색 그라데이션 — tools/orin-dashboard/static/index.html 의 irColor() 와
# 정확히 같은 세 구간 기준이다(같은 저장소 안의 로컬 대시보드 색 규칙과 다르게
# 보이면 "관제에서 다른 색으로 뜬다"는 새로운 혼란이 생긴다). 실측 근거 없는
# 잠정값이라는 것도 그대로 승계 — 값을 여기서 새로 지어내지 않는다.
IR_COOL_C, IR_WARM_C, IR_HOT_C = 20.0, 35.0, 45.0


def _ir_color(temp_c):
    """온도(°C) → (r,g,b) 0~255. index.html irColor() 포팅 — 실온은 무채색,
    뜨거울 때만 색이 들어온다."""
    if temp_c <= IR_WARM_C:
        k = max(0.0, min(1.0, (temp_c - IR_COOL_C) / (IR_WARM_C - IR_COOL_C)))
        g = 30 + k * 200
        return int(g), int(g), int(g)
    if temp_c <= IR_HOT_C:
        k = (temp_c - IR_WARM_C) / (IR_HOT_C - IR_WARM_C)
        return (int(230 + k * (255 - 230)), int(230 + k * (140 - 230)),
                int(230 + k * (0 - 230)))
    k = max(0.0, min(1.0, (temp_c - IR_HOT_C) / 15.0))
    return 255, int(40 + k * (255 - 40)), int(0 + k * (255 - 0))


def _png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def _encode_thermal_png(pixels_c, width, height):
    """온도(°C) 그리드를 8-bit RGB PNG 로 그려 base64 문자열로 돌려준다.

    표준 라이브러리만 쓴다(zlib·struct·base64) — 모듈 docstring 의 "표준 lib
    원칙" 예외는 websockets 하나뿐이라, PIL 등 이미지 라이브러리를 새로 넣지
    않는다. 해상도는 원본 그대로(기본 32×24) 둔다 — 로컬 대시보드도 서버에서
    업스케일하지 않고 캔버스에서 pixelated 로 키운다(index.html), 그 관례를
    따른다.
    """
    row_stride = width * 3
    raw = bytearray((row_stride + 1) * height)
    pos = 0
    for y in range(height):
        raw[pos] = 0                              # PNG 필터 타입: None
        pos += 1
        base = y * width
        for x in range(width):
            r, g, b = _ir_color(pixels_c[base + x])
            raw[pos] = r
            raw[pos + 1] = g
            raw[pos + 2] = b
            pos += 3
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 6)
    png = (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr)
           + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b""))
    return base64.b64encode(png).decode("ascii")


def _rotate_cw90(pixels_c, width, height):
    """그리드를 시계방향 90도 회전한다. (width, height) → (height, width) 로 바뀐다.

    🔴 [2026-08-04] 1차 시도(좌우반전, _mirror_horizontal — 이제 삭제)를 배포했으나
    사용자가 화면에서 재확인한 결과 여전히 방향이 안 맞았다. 사용자가 육안으로
    직접 비교해 **시계방향 90도 회전**으로 지시했다 — 반전은 틀린 것으로 판명났으므로
    빼고 회전만 적용한다(둘을 합성하지 않는다).
    공식: 원본 (row=y, col=x), 0<=y<height, 0<=x<width 가
          결과 (row=x, col=height-1-y) 로 옮겨간다 — 결과 격자는 width_new=height,
          height_new=width. (numpy 였다면 np.rot90(grid, k=-1) 과 동일)
    ⚠️ 여전히 안 맞으면: 반시계(k=1, new[width-1-x][y])나 180도를 시도할 것 —
    이번에도 실측(예: 알려진 방향에 손 대고 확인) 없이 사용자 육안 판단만으로 정한
    값이다.
    """
    new_width, new_height = height, width
    out = [0.0] * (new_width * new_height)
    for y in range(height):
        row_base = y * width
        for x in range(width):
            new_row = x
            new_col = height - 1 - y
            out[new_row * new_width + new_col] = pixels_c[row_base + x]
    return out, new_width, new_height


def _rotate_cw180(pixels_c, width, height):
    """그리드를 시계방향 180도 회전한다. 치수는 그대로(width, height) 유지된다.

    🔴 [2026-08-04 · 3차 수정] 90도 회전(_rotate_cw90)을 배포했으나 사용자가
    화면에서 재확인한 결과 여전히 안 맞았고, 이번엔 **180도**로 지시했다 —
    직전 수정(90도)을 **대체**한다(90도에 90도를 더 얹는 게 아니라, 원본
    기준 180도가 정답이라는 뜻). 구현은 _rotate_cw90 을 두 번 적용한 것과
    같다(검증하기 가장 쉬운 형태 — 90도 함수 자체는 이미 별도로 테스트돼 있다).
    (numpy 였다면 np.rot90(grid, k=-2) 과 동일 — 단순 pixels_c[::-1] 전체반전과도
    수학적으로 동치다: 180도 회전은 좌우반전 + 상하반전의 합성이다.)
    ⚠️ 이번에도 실측이 아니라 사용자 육안 판단 기준이다. 또 안 맞으면 다음은
    반시계 90도(k=1)를 시도할 차례 — 시계 90/180 을 순서대로 배제했으니 남은
    후보는 그것과 무회전뿐이다.
    """
    rotated, w2, h2 = _rotate_cw90(pixels_c, width, height)
    rotated, w2, h2 = _rotate_cw90(rotated, w2, h2)
    return rotated, w2, h2


def build_thermal(robot_id, thermal, seq):
    """THERMAL_FILE(/tmp/ir.json)의 MLX90640 그리드를 VIDEO_FRAME(channel=THERMAL)
    으로. server.py 의 /api/thermal(_thermal()) 과 같은 계약을 따른다 — pixels 는
    온도(°C)*10 의 int, width/height 기본 32/24.

    신선도(파일이 오래됐는지)는 이 함수의 책임이 아니다 — 호출부(Bridge.thermal_sender)
    가 mtime 을 보고 판단해서 넘긴다. THERMAL_FILE 에는 cam.json 과 달리 "t" 필드가
    없어서(server.py 의 _thermal() 도 os.path.getmtime 을 쓴다) 이 모듈의 fresh()
    로는 판정할 수 없다 — 그래서 여기서는 순수 변환만 한다(테스트하기도 더 쉽다).

    FE 계약(FE/bbiyong-react LiveSimBridge.tsx) — 채널이 Uint8Array 가 아니면
    {channel, format, data, maxTemp} 형태의 이미지 프레임을 기대하고
    `data:image/${format};base64,${data}` 로 그린다. maxTemp 는 캔버스 HUD
    ("MAX xx.x°C")에 그대로 쓰인다(Simulation.ts).
    """
    if not thermal:
        return None
    pixels_raw = thermal.get("pixels") or []
    width = thermal.get("width", 32)
    height = thermal.get("height", 24)
    if not pixels_raw or len(pixels_raw) != width * height:
        return None
    try:
        pixels_c = [float(v) / 10.0 for v in pixels_raw]
        pixels_c, width, height = _rotate_cw180(pixels_c, width, height)
        data = _encode_thermal_png(pixels_c, width, height)
    except (TypeError, ValueError, struct.error):
        return None
    return {
        "source": "robot",
        "type": "VIDEO_FRAME",
        "robot_id": robot_id,
        "channel": "THERMAL",
        "format": "png",
        "data": data,
        "seq": seq,
        "maxTemp": round(max(pixels_c), 1),
    }


class FireConfirmer:
    """cam.json 의 dets 에서 N/M 규칙으로 화재를 확정한다.

    update() 는 (경보를 지금 보낼지, confidence) 를 돌려준다. 상승엣지(막 확정됨)
    또는 확정 지속 중 재경보 간격이 지났을 때만 True 다.
    """

    def __init__(self, n=FIRE_N, m=FIRE_M, reemit_sec=FIRE_REEMIT_SEC,
                 min_conf=FIRE_MIN_CONF):
        self.n = n
        self.m = m
        self.reemit_sec = reemit_sec
        self.min_conf = min_conf
        self.history = []
        self.active = False
        self.last_emit = 0.0

    @staticmethod
    def _conf(det):
        """탐지의 conf 를 float 으로. 없거나 숫자가 아니면 0.0 — 신뢰도를 모르는
        탐지는 임계값을 통과하지 못한다(모르는 것을 통과시키면 게이트가 무의미)."""
        try:
            return float(det.get("conf", 0.0))
        except (TypeError, ValueError):
            return 0.0

    def update(self, cam, now):
        dets = (cam or {}).get("dets") or []
        # 🆕 min_conf 미만은 여기서 탈락 — 이 프레임은 "화재 아님"으로 세어진다.
        fire_dets = [
            d for d in dets
            if d.get("cls") == 1 and self._conf(d) >= self.min_conf
        ]
        self.history.append(bool(fire_dets))
        if len(self.history) > self.n:
            self.history.pop(0)
        confirmed = sum(self.history) >= self.m

        confidence = max((self._conf(d) for d in fire_dets), default=0.0)

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


def hot_pixel_floor(thermal, min_hot_pixels=OVERHEAT_MIN_HOT_PIXELS):
    """가장 뜨거운 `min_hot_pixels` 개 중 **가장 낮은** 온도(°C)를 돌려준다.

    이 값이 임계를 넘었다는 것은 곧 "임계를 넘은 픽셀이 `min_hot_pixels` 개 이상
    있다"는 뜻이다. min_hot_pixels=2 면 2번째로 뜨거운 픽셀의 온도이므로, 고립된
    불량 픽셀 1개짜리 스파이크는 여기서 걸러진다.

    표시용 최고온도(build_thermal 의 maxTemp)와 **다른 값**이라는 점이 중요하다 —
    경보 판정에만 쓰고, 관제에 보고하는 온도는 여전히 화면과 같은 raw max 다.
    픽셀이 없거나 형식이 틀리면 None(판정 불가 → 경보 안 냄).
    """
    pixels_raw = (thermal or {}).get("pixels") or []
    if len(pixels_raw) < min_hot_pixels:
        return None
    try:
        hottest = sorted((float(v) for v in pixels_raw), reverse=True)
    except (TypeError, ValueError):
        return None
    return hottest[min_hot_pixels - 1] / 10.0


class OverheatConfirmer:
    """열화상 최고온도가 임계값을 넘는지 N/M 규칙으로 확정한다.

    FireConfirmer 와 일부러 같은 모양(update → (emit, ...), 상승엣지 + 재경보 간격)
    으로 만들었다. 경보 두 종류가 서로 다른 규칙으로 튀면 "왜 이건 뜨고 저건 안 뜨나"
    를 추적하기 어렵다.

    update(max_temp_c, now) 는 (경보를 지금 보낼지, 최고온도) 를 준다.
    max_temp_c 가 None 이면(프레임 없음·낡음) "임계 미만" 으로 센다 — 센서가 죽었을 때
    마지막 뜨거운 프레임으로 경보를 계속 유지하지 않기 위해서다.
    """

    def __init__(self, threshold_c=OVERHEAT_TEMP_C, n=OVERHEAT_N, m=OVERHEAT_M,
                 reemit_sec=OVERHEAT_REEMIT_SEC):
        self.threshold_c = threshold_c
        self.n = n
        self.m = m
        self.reemit_sec = reemit_sec
        self.history = []
        self.active = False
        self.last_emit = 0.0

    def update(self, max_temp_c, now):
        over = max_temp_c is not None and float(max_temp_c) >= self.threshold_c
        self.history.append(bool(over))
        if len(self.history) > self.n:
            self.history.pop(0)
        confirmed = sum(self.history) >= self.m

        emit = False
        if confirmed:
            rising = not self.active
            due = (now - self.last_emit) >= self.reemit_sec
            if rising or due:
                emit = True
                self.last_emit = now
        self.active = confirmed
        return emit, max_temp_c


def build_overheat(robot_id, max_temp_c, nav_live, now,
                   threshold_c=OVERHEAT_TEMP_C, thermal_image=None):
    """EVENT_OVERHEAT 패킷을 조립한다.

    🔴 필드 모양은 **인터페이스 초안(§5.3)이 아니라 BE_system 이 실제로 구현한
       RobotPacket 을 따른다.** 초안은 중첩(`thermal:{max_temp, threshold}`)이지만,
       서버의 `wss/dto/RobotPacket.java` 는 **평탄한** `temperature`/`threshold` 를
       읽는다(`RobotWebSocketHandler` 의 `case "EVENT_OVERHEAT"` 이
       `packet.getTemperature()`/`getThreshold()` 를 로깅한다). 초안대로 중첩해
       보내면 `@JsonIgnoreProperties(ignoreUnknown = true)` 때문에 **에러 없이
       조용히 null 로 수신된다** — 가장 찾기 어려운 종류의 실패다.
       같은 이유로 기존 build_fire() 도 평탄한 `confidence` 를 쓰고 있다.

    `equipment_id` 는 `None` 이다 — 초안 §5.3 의 결론 그대로다. 로봇은 자기 좌표와
    온도만 알 뿐 설비 목록을 갖고 있지 않으므로, `location` 으로 어느 설비인지
    판정하는 것은 설비 DB 를 가진 서버의 책임이다.
    """
    packet = {
        "source": "robot",
        "type": "EVENT_OVERHEAT",
        "robot_id": robot_id,
        "equipment_id": None,
        "temperature": round(float(max_temp_c), 1),
        "threshold": threshold_c,
    }
    if thermal_image:
        # RobotPacket.thermalImage — 경보와 함께 중계되고 서버에 저장되지는 않는다.
        # thermal_sender 가 이미 인코딩해 둔 PNG 를 재사용하므로 추가 비용이 없다.
        packet["thermalImage"] = thermal_image
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
        # 🆕 열화상 송신 (S15P11E101 열화상 관제 미표시 수정). 하드웨어 주사율이
        # 이미 ≈1Hz 로 낮다(-663/-664/-667) — 기본 폴링도 그와 맞춰 1Hz 로 두고,
        # FRONT 와 똑같이 자주 찌르지 않는다. hz<=0 이면 완전히 끈다(map·nav 와
        # 같은 패턴 — 문제가 생기면 재배포 없이 끌 수 있게).
        thermal_hz = getattr(args, "thermal_hz", 1.0)
        self.thermal_enabled = thermal_hz > 0
        self.thermal_period = (1.0 / thermal_hz) if self.thermal_enabled else None
        self.thermal_file = str(getattr(args, "thermal_file", THERMAL_FILE))
        self.thermal_seq = 0
        # 🆕 과열 경보. 임계값 <=0 이면 완전히 끈다(thermal_hz 와 같은 패턴 —
        # 오발동이 나면 재배포 없이 CLI/env 로 끌 수 있게).
        self.overheat_temp_c = float(
            getattr(args, "overheat_temp_c", OVERHEAT_TEMP_C)
        )
        self.overheat_enabled = self.overheat_temp_c > 0
        self.overheat = (
            OverheatConfirmer(threshold_c=self.overheat_temp_c)
            if self.overheat_enabled else None
        )
        self.fire = FireConfirmer(
            min_conf=float(getattr(args, "fire_min_conf", FIRE_MIN_CONF))
        )
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
            env = read_json(ENV_FILE)

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
                env=env,
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

    async def thermal_sender(self, ws):
        """열화상(MLX90640) 영상 루프. FRONT 와 별도 주기·별도 태스크로 뗀다.

        하드웨어 자체가 ≈1Hz 로 느리므로(-663/-664/-667) 매 폴링마다 새로
        인코딩·전송하면 낭비다 — THERMAL_FILE 의 mtime 이 바뀌었을 때만
        PNG 를 새로 만들어 보낸다(파일 내용에 "t" 필드가 없어 cam.json 처럼
        fresh()/타임스탬프 비교를 못 쓴다 — server.py _thermal() 과 같은 이유로
        mtime 을 쓴다). 오래된 파일(THERMAL_STALE_S 초과)은 아예 건너뛴다 —
        연결 끊긴 마지막 프레임을 "지금 값"인 양 계속 재전송하지 않기 위해서다.
        """
        last_mtime = None
        while True:
            try:
                mtime = os.path.getmtime(self.thermal_file)
                is_stale = (time.time() - mtime) > THERMAL_STALE_S
            except OSError:
                mtime = None
                is_stale = True
            if mtime is not None and mtime != last_mtime and not is_stale:
                last_mtime = mtime
                thermal = read_json(self.thermal_file)
                frame = build_thermal(self.robot_id, thermal, self.thermal_seq + 1)
                if frame:
                    self.thermal_seq += 1
                    await ws.send(json.dumps(frame))
                # 🆕 과열 판정은 **새 프레임 하나당 정확히 한 번**만 한다.
                #    이 분기 안에 두는 것이 핵심이다 — 바깥에 두면 폴링 주기마다
                #    같은 프레임을 다시 세어, 하드웨어가 멈춘 동안 M-of-N 이
                #    옛 프레임만으로 확정돼 버린다.
                await self._check_overheat(ws, frame, thermal)
            await asyncio.sleep(self.thermal_period)

    async def _check_overheat(self, ws, frame, thermal):
        """열화상 프레임 하나에 대해 과열 임계 판정 → EVENT_OVERHEAT 전송.

        판정에 쓰는 값과 보고하는 값이 **의도적으로 다르다**:
          - 판정: hot_pixel_floor() = 2번째로 뜨거운 픽셀 (고착 불량 픽셀 방어)
          - 보고: frame["maxTemp"] = raw 최고온도 (관제 HUD 에 뜨는 값과 동일)
        보고까지 floor 값으로 바꾸면 화면 숫자와 경보 숫자가 어긋나 혼란스럽다.
        반대로 판정까지 raw max 로 하면 불량 픽셀 하나로 오경보가 난다.
        """
        if not self.overheat:
            return
        # 임계 판정용 — 고온 픽셀이 min 개수 미만이면 None 이 되어 "임계 미만"으로 센다
        judged = hot_pixel_floor(thermal) if frame else None
        emit, _ = self.overheat.update(judged, time.time())
        if not emit:
            return
        temp = frame.get("maxTemp")            # 보고용 = 화면과 같은 raw 최고온도
        packet = build_overheat(
            self.robot_id, temp, read_json(NAV_LIVE_FILE), time.time(),
            threshold_c=self.overheat_temp_c,
            thermal_image=(frame or {}).get("data"),
        )
        await ws.send(json.dumps(packet))
        if self.event_clips:
            # event_clip_pipeline._canonical_event_type 이 "OVERHEAT" 를 이미
            # 정식 종류로 인식한다 — 블랙박스 클립 파이프라인이 화재와 똑같이
            # EVENT_SAVED 응답을 받아 영상을 올릴 수 있다.
            try:
                self.event_clips.note_event("OVERHEAT", time.time())
            except OSError as exc:
                print(
                    f"[event-clip] failed to persist overheat timestamp: {exc}",
                    flush=True,
                )
        # 두 숫자를 함께 남긴다 — 나중에 "왜 떴나/왜 안 떴나"를 로그만으로 설명하려면
        # 표시온도(max)와 판정온도(floor)가 모두 있어야 한다.
        print(f"[overheat] EVENT_OVERHEAT 송신 max={temp}°C "
              f"판정={judged}°C (임계 {self.overheat_temp_c}°C)", flush=True)

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
            if self.thermal_enabled:
                tasks.append(self.thermal_sender(ws))
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
        "--thermal-hz",
        type=float,
        default=float(os.environ.get("ORINCAR_THERMAL_HZ", "1")),
        help="열화상 송신 폴링 주기(Hz). 0 이하면 끈다. 하드웨어 자체가 ≈1Hz라 "
             "이보다 올려도 새 프레임을 더 자주 얻지는 못한다(-663/-664/-667)",
    )
    parser.add_argument(
        "--thermal-file",
        default=os.environ.get("ORINCAR_THERMAL_FILE", THERMAL_FILE),
        help="server.py 의 THERMAL_FILE 과 같은 파일(기본 /tmp/ir.json)",
    )
    parser.add_argument(
        "--overheat-temp-c",
        type=float,
        default=float(
            os.environ.get("ORINCAR_OVERHEAT_TEMP_C", str(OVERHEAT_TEMP_C))
        ),
        help="EVENT_OVERHEAT 발동 임계 온도(°C). 0 이하면 과열 경보를 끈다. "
             "기본 100 은 사용자 지정 운영 기준값이다",
    )
    parser.add_argument(
        "--fire-min-conf",
        type=float,
        default=float(
            os.environ.get("ORINCAR_FIRE_MIN_CONF", str(FIRE_MIN_CONF))
        ),
        help="EVENT_FIRE 를 올릴 최소 YOLO 신뢰도(0~1). 미만인 탐지는 M-of-N "
             "확정 카운트에도 들어가지 않는다. 기본 0.60 은 사용자 지정값",
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
