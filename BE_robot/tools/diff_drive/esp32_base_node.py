#!/usr/bin/env python3
"""ESP32 하드웨어 브리지 — /cmd_vel 을 받고 /odom + TF 를 낸다.

이 노드가 **ESP32 시리얼 포트의 유일한 소유자**다. bench.py·roam.py 같은
실험 스크립트와 동시에 띄우면 포트 충돌이 난다 (하나만 실행할 것).

    ros2 run 대신 직접:
        python3 esp32_base_node.py --ros-args -p duty_max:=30.0

    🔑 파라미터 정본은 **이 파일의 declare_parameter 선언값**이다.
       base_up.sh · stack_up.sh 는 duty_max 하나만 오버라이드하므로
       track_width_m · laser_* 는 선언값이 곧 런타임 값이다.
       (구 예시 `-p track_width_m:=0.2124` 는 선언값 0.2130 과 어긋나 제거했다 — 2026-07-31)

구조
    /cmd_vel (Twist) ─→ 차동 기구학 ─→ `v <L> <R>` ─→ ESP32(속도 PID)
                                                        │
    /odom (Odometry) ←─ 원호 적분 ←─ 엔코더 카운트 ←────┘
    TF: odom→base_link (동적) · base_link→laser_frame (정적)

🔒 부호: speed_pid 펌웨어가 좌우 거울대칭을 이미 흡수했다(§D).
   따라서 여기서는 **양쪽 다 + = 전진**이며 right_wheel_direction 같은
   반전 파라미터를 두지 않는다. 두면 이중 반전이 된다.
"""
import base64
import binascii
import hashlib
import json
import math
import os
import re
import shutil
import socket
import struct
import sys
import threading
import time
from collections import deque
from datetime import datetime

import rclpy
import serial
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
from geometry_msgs.msg import Twist, TransformStamped, Quaternion
from nav_msgs.msg import Odometry
from sensor_msgs.msg import LaserScan
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import (
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
    qos_profile_sensor_data,
)
from rclpy.time import Time
from tf2_ros import (
    Buffer,
    StaticTransformBroadcaster,
    TransformBroadcaster,
    TransformListener,
)

from esp32_timing import McuTimeSynchronizer, parse_encoder_telemetry

# 🆕 대시보드 출력 제한 슬라이더 — server.py 가 원자적으로 떨구는 파일.
#    {"pct": 30, "ts": 1785306373.2}
#    server.py 는 표준 라이브러리만 쓰므로 ROS 를 모른다. 그래서 파일이
#    유일한 접점이고, 시리얼 유일 소유자인 이 노드가 펌웨어로 옮겨 준다.
#    🔴 2026-07-31 복구: 이 파일에 있던 이 기능(power_tick)이 다른 수정본
#    배포 과정에서 통째로 빠졌던 것을 07-29 백업(esp32_base_node.py.20260729_163014)
#    에서 되살렸다. 당시 있던 power_ack_tick(회신 확인)은 그 백업에도 없어서
#    복구하지 못했다 — 대신 2026-07-31에 새로 짰다(아래 POWER_ACK_FILE).
POWER_FILE = os.environ.get("ORINCAR_POWER_FILE", "/tmp/orincar_power.json")
# 🆕 되읽기 — esp32_base_node 가 펌웨어 `k?` 회신에서 뽑아 떨구는 **실제** duty_max.
#    CTL["power_pct"](server.py)는 이 프로세스가 기억하는 **명령값**이지 펌웨어에
#    물어본 결과가 아니다. esp32_base_node 가 죽어 있으면 POWER_FILE 은 갱신되는데
#    펌웨어는 못 받는다 — 그런데 화면은 새 값을 그대로 표시해버린다. 그 한 방향
#    신뢰를 끊으려고 반대 방향 파일을 하나 더 쓴다. server.py 의 POWER_ACK_FRESH_S(15s)
#    와 대칭 — 여기서는 5초마다 질의한다(3회 연속 실패해야 화면이 stale 로 본다).
POWER_ACK_FILE = os.environ.get("ORINCAR_POWER_ACK_FILE",
                                "/tmp/orincar_power_ack.json")
SERVO_FILE = "/tmp/orincar_servo.json"
# 🆕 서보 상태 되읽기 — 방향이 SERVO_FILE 과 **반대**다.
#    SERVO_FILE  = 대시보드 → 이 노드 (명령: "몇 도로 가라")
#    SERVO_STATE_FILE = 이 노드 → 대시보드 (상태: "마지막으로 실제 시리얼에 내보낸 각도")
#    🔴 SG90 류 RC 서보는 위치 피드백 배선이 없다 — 축이 진짜 그 각도에 있는지는
#    알 방법이 없다. 여기 담기는 값은 "펌웨어에 전송 성공한 마지막 명령각"(servo_angle_sent)
#    이지 실측 위치가 아니다. server.py·프런트는 이 사실을 라벨에 그대로 밝힌다.
#    POWER_ACK_FILE 과 같은 관례(원자적 쓰기, ts 로 신선도 판정).
SERVO_STATE_FILE = os.environ.get("ORINCAR_SERVO_STATE_FILE",
                                  "/tmp/orincar_servo_state.json")
# 🆕 DHT11(온습도) + INA226(배터리전압) — speed_pid.ino 가 1Hz 로 내는
#    `E,<millis>,<dht_ok>,<tempC>,<humidity%>,<ina_ok>,<batt_V>` 줄을
#    이 노드가 파싱해 떨군다. server.py 는 ROS 를 모르므로 POWER_FILE·
#    SERVO_FILE 과 같은 관례로 파일이 유일한 접점이다.
ENV_FILE = os.environ.get("ORINCAR_ENV_FILE", "/tmp/orincar_env.json")

# 🆕 배터리 % — "대충" 선형 매핑이다. 근거는 이미 확정된 두 값뿐이다:
#    만충 25.2V(6S 공칭 21.6V, CLAUDE.md 배터리 스펙) ·
#    19.0V(CLAUDE.md "19V 미만 30초 지속 → 복귀충전" 운영 트리거).
#    리튬 방전곡선은 비선형이라 이 값은 정밀 SoC 가 아니라 대략적 지표일 뿐이다.
#    실측 방전곡선이 생기기 전까지는 이 이상 정밀하게 만들지 않는다(지어내지 않는다).
BATT_EMPTY_V = 19.0
BATT_FULL_V = 25.2


def battery_percent(volts):
    if volts is None:
        return None
    pct = (volts - BATT_EMPTY_V) / (BATT_FULL_V - BATT_EMPTY_V) * 100.0
    return round(max(0.0, min(100.0, pct)), 1)


def yaw_to_quat(yaw):
    q = Quaternion()
    q.z = math.sin(yaw * 0.5)
    q.w = math.cos(yaw * 0.5)
    return q


class Esp32Base(Node):
    def __init__(self):
        super().__init__("esp32_base")

        # ── 파라미터 ────────────────────────────────────────────────
        self.declare_parameter("port", "/dev/esp32")
        self.declare_parameter("baud", 115200)
        # [실측] §J-2. 실부하에서 라이다 대비 0.5% 일치 검증됨 (2026-07-26)
        self.declare_parameter("mm_per_count", 0.16348)
        # 🔒 209.1mm — 2026-07-26 폐루프 검증값. 세 방법이 여기로 수렴했다:
        #    · §K 스캔 상호상관 201.8  … "제자리회전=순수회전" 가정이 깨짐
        #      (라이다가 회전중심에서 59.7mm 벗어난 것이 실측으로 확인됨)
        #    · 스핀+법선각 212.4        … 제자리회전 스크럽으로 카운트가 부풂(상한)
        #    · **odom vs 라이다 209.1** … 가장 직접적. 이 값으로 회전오차 1.6%→~0
        #    odom_check.py 로 언제든 재검증 가능.
        # [수정 2026-07-31] 7월 29일 차체 수평 복원으로 바퀴-바닥 기하학 변경 반영 (0.2091 -> 0.2130)
        # 윤거가 실효적으로 넓어짐을 보정해 파란 점 뒤로 밀림 현상 방지
        self.declare_parameter("track_width_m", 0.2130)
        # 🔴 0.30 → 1.00 (2026-07-27 사용자 결정). 이 파일의 다른 변경과 달리
        #    **이것은 실제로 거동을 바꾼다** — 게인 전송·주행로그 tee 는
        #    "파라미터를 안 건드리면 지금과 100% 같다"가 안전 근거였지만,
        #    이 항목에는 그 근거가 **해당하지 않는다.**
        #
        # 🔑 속도 상한이 **세 곳**에 있고, 셋 다 같은 값이어야 한다.
        #      teleop_node.py   V_MAX         (조종기)
        #      server.py        DRIVE_V_MAX   (웹 대시보드)
        #      여기             max_linear_mps (최종 클램프)
        #    **가장 낮은 하나가 이긴다.** 하나만 올리면 아무 변화가 없다 —
        #    2026-07-27 에 실제로 두 번 겪었다(teleop 만 1.0 으로 올렸는데
        #    여기 0.30 이 그대로라 "0.5 나 1.0 이나 똑같다"가 됐다).
        #    앞의 둘은 이미 1.00 으로 배포됐고, 이제 여기가 마지막 관문이다.
        #
        # 🔴 구동계가 1.0 m/s 를 낼 수 있는지는 **미지수다.**
        #    설계문서의 "능력 ≈0.098 m/s" 는 §L-5-1 **열화 상태** 개루프
        #    곡선에서 외삽한 값이라 정상 상태에 적용되지 않는다 —
        #    정상 상태에서는 명령 0.15 에 **0.142 m/s(95%)** 가 나왔고,
        #    0.098 이 진짜 상한이면 나올 수 없는 값이다.
        #    → 정상 상태 duty–속도 곡선은 **재측정 대상**이다.
        #    도달하지 못하면 PI 가 duty_max=80 에서 포화한다.
        #    **그 포화 여부를 보려고 이번에 주행로그 tee 를 넣은 것이다.**
        #
        # ⚠️ 안전: 사용자가 **사람이 지켜보며 조종한다**는 전제로 승인했다.
        #    데드맨 0.4 s 동안 1.0 m/s 면 **40 cm** 를 더 간다.
        #    라이다 가드 STOP_M=0.35 m 보다 크므로 **이 속도에서 가드는
        #    제동을 보장하지 못한다.** 무인 자율주행 전에 반드시 재검토할 것.
        self.declare_parameter("max_linear_mps", 1.00)
        self.declare_parameter("max_angular_rps", 1.2)
        self.declare_parameter("cmd_timeout_sec", 0.5)
        self.declare_parameter("publish_rate_hz", 30.0)
        self.declare_parameter("telemetry_gap_threshold_ms", 250)
        self.declare_parameter("diagnostics_rate_hz", 1.0)
        self.declare_parameter("scan_topic", "/scan")
        self.declare_parameter("odom_frame", "odom")
        self.declare_parameter("base_frame", "base_link")
        self.declare_parameter("laser_frame", "laser_frame")
        # [수정 2026-07-31] 7월 29일 차체 수평 복원(재조립)으로 인한 라이다 수평 투영 거리 축소 반영 (0.0597 -> 0.0550)
        self.declare_parameter("laser_x", 0.0550)
        self.declare_parameter("laser_y", -0.0051)
        # 🔄 2026-07-31 실차 확인 — -3.06639 rad 로 갱신.
        #    팀 be_robot/dev(커밋 880adbc, 2026-07-29)와 일치, Orin 실기
        #    (`~/calib/esp32_base_node.py`)도 이미 이 값이었다 — 개인 저장소만
        #    아래 07-26 구값에 뒤처져 있었다. 2026-07-29 재조립 때 라이다가
        #    재설치되며 방향이 바뀐 것으로 보이나, 정확히 언제·어떻게 재설치됐는지는
        #    [확인 필요] — 지어내지 않는다.
        #    확인: ssh orin "grep laser_yaw ~/calib/esp32_base_node.py"
        #
        #    (이력, 무효화됨) 🔒 +4.31° = +0.0752 rad — 2026-07-26 laser_yaw_calib.py
        #    3회 평균(전진 +4.52/+4.69, 후진 +3.71, 산포 ±0.5°). 평면 2개 + 직진
        #    이동벡터 방식. 전진·후진이 일치해 당시엔 짝짓기 계통오차가 아니라
        #    실제 마운트 오차로 판단했으나, 이후 라이다 재장착으로 무효가 됐다.
        self.declare_parameter("laser_yaw", -3.06639)

        # ── 🆕 펌웨어 게인 (`k` 명령으로 기동 시 전송) ──────────────
        # 🔴 기본값은 **speed_pid.ino 컴파일 기본값과 동일**하다
        #    (speed_pid.ino:43-50). 파라미터를 안 건드리면 거동이 100%
        #    지금과 같다 — 이것이 이 변경의 안전 근거다.
        # 포트를 열면 DTR 로 ESP32 가 리셋되어 `k` 값이 RAM 에서 날아가므로,
        # **노드가 열고 나서 다시 보내는 것**만이 재기동에도 유지된다.
        self.declare_parameter("send_tunables", True)
        self.declare_parameter("kp", 25.0)
        self.declare_parameter("ki", 60.0)
        self.declare_parameter("ff_slope", 0.0196)
        self.declare_parameter("ff_dead", 2.24)
        self.declare_parameter("i_limit", 40.0)
        # 🔒 80 유지 — 2026-07-27 사용자 결정 "80부터 가자".
        #    올려도 duty100 → 0.125 m/s 뿐이고(실측_데이터 §L-5-1 외삽),
        #    포화점만 옮길 뿐 제어 여유는 안 생긴다. 상세 설계문서 §3.
        self.declare_parameter("duty_max", 80.0)
        self.declare_parameter("v_alpha", 0.30)

        # ── 🆕 주행로그 (docs/주행로그_설계_2026-07-27.md) ───────────
        self.declare_parameter("trace_dir", os.path.expanduser("~/drivelog"))
        self.declare_parameter("purpose", "")      # ⭐ 빈 값이면 로깅 비활성
        self.declare_parameter("chassis_id", "")   # ⭐ 〃

        g = lambda k: self.get_parameter(k).value            # noqa: E731
        self.mm_per_count = float(g("mm_per_count"))
        self.track = float(g("track_width_m"))
        self.max_lin = float(g("max_linear_mps"))
        self.max_ang = float(g("max_angular_rps"))
        self.cmd_timeout = float(g("cmd_timeout_sec"))
        self.odom_frame = g("odom_frame")
        self.base_frame = g("base_frame")
        command_rate_hz = float(g("publish_rate_hz"))
        diagnostics_rate_hz = float(g("diagnostics_rate_hz"))
        if command_rate_hz <= 0.0 or diagnostics_rate_hz <= 0.0:
            raise ValueError("publish_rate_hz and diagnostics_rate_hz must be positive")

        # ── 상태 ────────────────────────────────────────────────────
        self.x = self.y = self.th = 0.0
        self.v = self.w = 0.0
        self.tgt_l = self.tgt_r = 0.0
        self.last_cmd_t = 0.0
        self.prev_lc = self.prev_rc = None
        self.lock = threading.Lock()
        self.mcu_clock = McuTimeSynchronizer()
        self.telemetry_gap_threshold_ms = int(g("telemetry_gap_threshold_ms"))
        if self.telemetry_gap_threshold_ms <= 0:
            raise ValueError("telemetry_gap_threshold_ms must be positive")
        self.telemetry_received = 0
        self.odom_published = 0
        self.malformed_telemetry = 0
        self.nonmonotonic_timestamps = 0
        self.mcu_resets = 0
        self.mcu_rollovers = 0
        self.telemetry_gaps = 0
        self.last_arrival_ns = None
        self.last_odom_stamp_ns = None
        self.transport_latency_ms = deque(maxlen=500)
        self.scan_count = 0
        self.scan_tf_available = 0
        self.last_scan_tf_age_ms = None
        self.last_diag_values = None
        # 주행로그 상태 — serial_loop 스레드 전용. 락을 걸지 않는다
        self.trace_root = str(g("trace_dir"))
        self.trace_fp = None
        self.trace_dir = None
        self.trace_meta = None
        self.trace_pending = 0
        self.fw_banner = None
        self.fw_tunables = None

        # ── 시리얼 ──────────────────────────────────────────────────
        self.ser = serial.Serial(g("port"), int(g("baud")), timeout=0.2)
        time.sleep(2.0)                       # ESP32 리셋 대기
        # 🔑 버리지 말고 회수한다 — 부팅 배너(speed_pid.ino:225-227)가
        #    meta.json 의 fw_banner 다. 지금까지 매 기동 폐기돼 왔다.
        self.fw_banner = self._drain_boot_banner()
        # 🔑 게인 전송은 **리더 스레드 시작 전**이어야 한다.
        #    여기서는 self.ser 를 단독·동기적으로 쓸 수 있어 경합이 없다.
        self.fw_tunables = self._send_tunables()
        self.get_logger().info(f"ESP32 연결 {g('port')} · 윤거 {self.track:.4f} m")

        # ── ROS 인터페이스 ──────────────────────────────────────────
        qos = QoSProfile(reliability=ReliabilityPolicy.RELIABLE,
                         history=HistoryPolicy.KEEP_LAST, depth=10)
        self.create_subscription(Twist, "/cmd_vel", self.on_cmd, qos)
        self.pub_odom = self.create_publisher(Odometry, "/odom", qos)
        self.pub_diag = self.create_publisher(DiagnosticArray, "/diagnostics", 10)
        self.tf = TransformBroadcaster(self)
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self, spin_thread=False)
        self.create_subscription(
            LaserScan,
            g("scan_topic"),
            self.on_scan,
            qos_profile_sensor_data,
        )

        # 🔴 self 에 붙여 살려둬야 한다. 지역변수로 두면 __init__ 종료 시
        #    GC되고, latch(transient_local)된 정적 TF도 같이 사라진다.
        self.static_tf = StaticTransformBroadcaster(self)
        t = TransformStamped()
        t.header.stamp = self.get_clock().now().to_msg()
        t.header.frame_id = self.base_frame
        t.child_frame_id = g("laser_frame")
        t.transform.translation.x = float(g("laser_x"))
        t.transform.translation.y = float(g("laser_y"))
        t.transform.rotation = yaw_to_quat(float(g("laser_yaw")))
        self.static_tf.sendTransform(t)
        self.get_logger().info(
            f"정적 TF {self.base_frame}→{g('laser_frame')} "
            f"x={g('laser_x'):+.4f} y={g('laser_y'):+.4f} [실측]")

        # 🔑 fw_tunables 가 확보된 뒤에 열어야 meta 에 **실제 적용값**이 들어간다
        self._open_trace()

        # 🆕 출력 제한 — 마지막으로 **펌웨어에 실제로 보낸** 값.
        #    None = 아직 한 번도 안 보냄 → 첫 관측값은 무조건 보낸다
        #    (기동 순서가 어떻든 화면과 펌웨어를 한 번은 맞춘다).
        self.power_pct_sent = None
        self.power_warned = False      # 경고는 한 번만. 1Hz 로그 폭주 방지
        # 🆕 되읽기(ack) 상태 — 질의는 이 스레드(타이머)에서, 응답 파싱은
        #    serial_loop(리더 스레드)에서 한다. 시리얼 read는 리더 스레드
        #    하나로만 해야 경합이 없다 — 여기서 직접 readline 하지 않는다.
        self.power_pct_ack = None
        self.power_ack_query_warned = False   # 조회 전송 실패 경고 1회만
        self.power_ack_write_warned = False   # ack 파일 쓰기 실패 경고 1회만

        self.servo_angle_sent = None
        self.servo_warned = False
        self.servo_state_write_warned = False   # 상태파일 쓰기 실패 경고 1회만

        self.reader = threading.Thread(target=self.serial_loop, daemon=True)
        self.reader.start()
        # Command/watchdog output stays periodic. Odometry is emitted only when
        # encoder telemetry arrives, using the MCU acquisition timestamp.
        self.create_timer(1.0 / command_rate_hz, self.command_tick)
        self.create_timer(1.0 / diagnostics_rate_hz, self.publish_diagnostics)
        # 🆕 출력 제한 감시 1Hz. 슬라이더는 사람 손이라 1Hz 면 충분하고,
        #    더 빠르게 돌면 stat() 만 늘고 얻는 게 없다.
        self.create_timer(1.0, self.power_tick)
        # 🆕 출력 제한 회신 질의 5Hz가 아니라 0.2Hz(5초) — server.py의
        #    POWER_ACK_FRESH_S=15s와 맞춘 생산 주기(3회 연속 실패해야 stale).
        self.create_timer(5.0, self.power_ack_tick)
        self.create_timer(0.2, self.servo_tick)

    # ══════════════════════════════════════════════════════════════
    # 게인 전송 (설계문서 §2)
    # ══════════════════════════════════════════════════════════════
    # ROS 파라미터명 → speed_pid.ino:190-197 의 `k` 서브키
    TUNABLE_KEYS = (
        ("kp", "p"), ("ki", "i"), ("ff_slope", "f"), ("ff_dead", "z"),
        ("i_limit", "l"), ("duty_max", "x"), ("v_alpha", "a"),
    )

    # ── 🆕 출력 제한 감시 (대시보드 슬라이더 → 펌웨어 duty_max) ──────
    def power_tick(self):
        """POWER_FILE 을 1Hz 로 읽어 **바뀐 값만** 펌웨어에 밀어 넣는다.

        🔴 어떤 예외도 밖으로 내보내지 않는다. 이 노드는 오도메트리를 담당한다 —
           /tmp 파일 하나 못 읽었다고 주행이 멈추면 안 된다. `_trace_write` 와
           같은 방침이다(실패는 삼키고 기능만 조용히 쉰다).
        🔑 파일이 없거나 깨졌으면 **아무것도 하지 않는다.** 기동 시 ROS 파라미터
           duty_max 로 이미 보낸 값이 그대로 유효하다 — 0 으로 떨어뜨리지 않는다.
        🔑 매 틱 보내지 않는다. 같은 값을 1Hz 로 계속 쏘면 시리얼 대역을 먹고
           펌웨어가 매번 printTunables() 로 8줄을 되뱉어 T줄 사이에 끼어든다.
        """
        try:
            with open(POWER_FILE) as f:
                pct = int(round(float(json.load(f)["pct"])))
        except Exception:                       # noqa: BLE001 — 없음/깨짐/권한 전부
            return                              # 조용히 넘어간다. 다음 틱에 또 본다
        pct = max(0, min(100, pct))             # 서버가 이미 잘랐지만 여기서도 자른다
        if pct == self.power_pct_sent:
            return

        # 🔴 펌웨어 명령은 `x 30` 이 아니라 **`kx30.000000`** 이다.
        #    speed_pid.ino:190-201 의 최상위 switch 에 'x' 케이스가 없다 — 'k' 아래
        #    서브키다. 공백을 넣으면 서브키가 ' ' 가 되어 무시되고,
        #    지수표기는 parseFloat 이 못 읽는다. TUNABLE_KEYS 의 매핑을 그대로 쓴다.
        key = dict(self.TUNABLE_KEYS)["duty_max"]
        try:
            self.ser.write(f"k{key}{float(pct):.6f}\n".encode())   # 단일 write
        except Exception as e:                  # noqa: BLE001
            if not self.power_warned:
                self.get_logger().warn(f"출력 제한 전송 실패: {e}")
                self.power_warned = True
            return
        prev = self.power_pct_sent
        self.power_pct_sent = pct
        self.power_warned = False
        self.get_logger().info(
            f"출력 제한 {'—' if prev is None else prev}% → {pct}% "
            f"(k{key}{float(pct):.1f} 전송)")

    def power_ack_tick(self):
        """5초마다 펌웨어에 `k?`를 물어 실제 duty_max 를 회신받는다.

        🔴 응답은 여기서 안 읽는다 — 시리얼 read 는 리더 스레드(`serial_loop`)
           하나로만 해야 경합이 없다(동시에 두 스레드가 readline 하면 어느 쪽이
           줄을 가져갈지 보장이 없다). 여기서는 질의만 던지고, 실제 파싱과
           ACK 파일 쓰기는 `serial_loop` 가 "# kp=..." 회신 줄을 받았을 때
           `_handle_tunables_echo` 에서 처리한다. `power_tick` 이 보내는
           `kx<pct>` 명령도 펌웨어가 항상 `printTunables()` 로 같은 형식의
           줄을 되뱉으므로(speed_pid.ino 의 'k' 케이스 마지막), 값이 바뀔
           때마다 이 5초를 기다리지 않고도 더 빨리 ACK 가 갱신된다.
        """
        try:
            self.ser.write(b"k?\n")
            self.ser.flush()
        except Exception as e:                  # noqa: BLE001
            if not self.power_ack_query_warned:
                self.get_logger().warn(f"출력 제한 회신 질의 실패: {e}")
                self.power_ack_query_warned = True
            return
        self.power_ack_query_warned = False

    def servo_tick(self):
        # 🔴 종전에는 int() 라 1도 단위였다. 펌웨어 `c` 파서를 0.1도까지 받도록 고쳐도
        #    여기(와 server.py `_servo`)가 먼저 자르면 아무 효과가 없다 — 낮은 쪽이 이긴다.
        #    IPM 거리추정에서 카메라 pitch 0.66° 오차는 1 m 에서 7.9% 다
        #    (docs/단안깊이_조사_2026-08-02.md §3-2 · 링크 레버비 0.66 은 노즈설계 §5).
        #    0.1도로 양자화해 두면 float 동등비교가 안전하고 전송 문자열도 결정적이다.
        #
        # 🆕 이 함수 끝에서 매 틱(5Hz) SERVO_STATE_FILE 을 갱신한다 — agy 검토 결과
        #    "1Hz 하트비트만으로는 확정 지연이 최대 1초"라는 지적을 받아, 새 명령을
        #    보낸 바로 그 틱에서 즉시 반영하도록 했다(이미 5Hz 로 돌던 타이머라
        #    타이머를 새로 만들 필요가 없었다). 명령이 없어도 매 틱 ts 를 갱신해
        #    "노드가 살아 있다"는 신선도(하트비트)를 유지한다 — _write_power_ack 와
        #    같은 방침이다.
        try:
            with open(SERVO_FILE) as f:
                angle = float(json.load(f).get("angle", 90))
            angle = round(max(0.0, min(180.0, angle)), 1)
        except Exception:
            angle = None      # 명령 파일 없음/깨짐 — 새 명령이 없다는 뜻, 정지 아님

        if angle is not None and angle != self.servo_angle_sent:
            try:
                self.ser.write(f"c {angle:.1f}\n".encode())
                self.ser.flush()
                self.servo_angle_sent = angle
                self.servo_warned = False
            except Exception as e:
                if not self.servo_warned:
                    self.get_logger().warn(f"서보명령 전송 실패: {e}")
                    self.servo_warned = True

        self._write_servo_state()

    def _write_servo_state(self):
        """SERVO_STATE_FILE 에 servo_angle_sent 를 원자적으로 떨군다.

        POWER_ACK_FILE(`_write_power_ack`)과 같은 관례 — 값이 안 바뀌어도 매번
        쓴다. ts 를 계속 갱신해야 대시보드가 "노드가 살아서 최근에 확인해줬다"는
        신선도를 판정할 수 있다. servo_angle_sent 가 아직 None(기동 후 명령을
        한 번도 못 받음)이어도 그대로 쓴다 — "모른다"를 굳이 숨기지 않는다.
        """
        tmp = SERVO_STATE_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"angle_sent": self.servo_angle_sent, "ts": time.time()}, f)
            os.replace(tmp, SERVO_STATE_FILE)
        except OSError as e:
            if not self.servo_state_write_warned:
                self.get_logger().warn(
                    f"서보 상태 파일 쓰기 실패 {SERVO_STATE_FILE}: {e}")
                self.servo_state_write_warned = True
            return
        self.servo_state_write_warned = False

    def _handle_tunables_echo(self, line):
        """`# kp=... duty_max=<pct> ...` 회신 줄에서 duty_max 를 뽑아 ACK 파일에 쓴다.

        🔑 매번(값이 안 바뀌어도) 쓴다 — ts 를 계속 갱신해야 "노드가 살아서
           확인해줬다"는 신선도(POWER_ACK_FRESH_S)가 유지된다. 값 중복을
           걸러내면(power_tick 처럼) 안 바뀐 채 오래 유지될 때 화면이
           틀리게 stale 로 떨어진다 — 그건 이 기능의 존재 이유와 반대다.
        """
        m = re.search(r"duty_max=([\d.]+)", line)
        if not m:
            return
        pct = int(round(float(m.group(1))))
        self.power_pct_ack = pct
        self._write_power_ack(pct)

    def _write_power_ack(self, pct):
        """server.py 의 `_write_power_file` 과 대칭 — 원자적으로 쓴다.

        읽는 쪽(`_read_power_ack`)은 옛 값 아니면 새 값만 본다.
        """
        tmp = POWER_ACK_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"pct": int(pct), "ts": time.time()}, f)
            os.replace(tmp, POWER_ACK_FILE)
        except OSError as e:
            if not self.power_ack_write_warned:
                self.get_logger().warn(
                    f"출력 제한 ack 파일 쓰기 실패 {POWER_ACK_FILE}: {e}")
                self.power_ack_write_warned = True
            return
        self.power_ack_write_warned = False

    def _handle_env_telemetry(self, raw):
        """`E,<millis>,<dht_ok>,<tempC>,<humidity%>,<ina_ok>,<batt_V>` → 상태 파일.

        speed_pid.ino 가 T,/IR, 과는 별도로 1Hz 로 내는 줄이다(주석 참고:
        firmware/speed_pid/speed_pid.ino 의 "환경/배터리 센서" 절). 여기서는
        문자열 split + float 변환뿐이라 오도메트리 실시간성에 영향이 없다.
        🔴 어떤 예외도 밖으로 내보내지 않는다 — 센서 한 줄 파싱 실패로 리더
           스레드가 죽으면 안 된다(다른 _write_* 헬퍼들과 같은 방침).
        """
        try:
            parts = raw.split(",")
            if len(parts) != 7:
                return
            _, _millis, dht_ok, temp_c, humidity, ina_ok, batt_v = parts
            dht_ok = bool(int(dht_ok))
            ina_ok = bool(int(ina_ok))
            # 펌웨어는 실패 시 이전 값을 래치해서 보내지만(NaN 방지), 여기서는
            # *_ok 가 false 면 신뢰할 수 없는 값으로 보고 None 처리한다 — 화면이
            # "한 번도 못 읽었는데 0.0 이 찍혀 있다"를 참으로 만들지 않기 위해서다.
            volts = float(batt_v) if ina_ok else None
            payload = {
                "ts": time.time(),
                "battery": {
                    "connected": ina_ok,
                    "volts": volts,
                    "percent": battery_percent(volts),
                },
                "env": {
                    "connected": dht_ok,
                    "temp_c": float(temp_c) if dht_ok else None,
                    "humidity_pct": float(humidity) if dht_ok else None,
                },
            }
            tmp = ENV_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(payload, f)
            os.replace(tmp, ENV_FILE)
        except Exception as e:                   # noqa: BLE001
            self.get_logger().error(f"E, 파싱/기록 실패: {e}")

    def _read_lines(self, budget_s):
        """budget_s 동안 도착한 줄을 모은다. 예외를 밖으로 내보내지 않는다."""
        out, end = [], time.time() + budget_s
        while time.time() < end:
            try:
                line = self.ser.readline().decode(errors="replace").strip()
            except Exception:
                break
            if line:
                out.append(line)
        return out

    def _drain_boot_banner(self):
        """부팅 배너를 회수하고 입력버퍼를 비운다 (reset_input_buffer 대체)."""
        try:
            lines = self._read_lines(0.3)
            self.ser.reset_input_buffer()
        except Exception as e:
            self.get_logger().warn(f"배너 회수 실패: {e}")
            return None
        for line in lines:
            self.get_logger().info(f"펌웨어 {line}")
        return " | ".join(lines) if lines else None

    def _send_tunables(self):
        """기동 시 펌웨어 게인을 밀어 넣고 `k?` 로 확인한다.

        🔴 `k` 파서 버그 — speed_pid.ino:186 이 'k' **다음 한 글자**를 그대로
           서브키로 읽는다. 공백을 넣으면 서브키가 ' ' 가 되어 무시된다.
           → 반드시 `kx80.000000` 처럼 **붙여서** 보낼 것. `k x 80` 은 안 된다.
        🔴 한 줄을 반드시 **단일 write** 로 보낸다 (설계문서 §2-3).
           'k' 만 버퍼에 들어간 순간 ESP32 가 진입하면 Serial.read() 가 -1 을
           반환해 게인이 조용히 유실된다.
        🔴 지수표기 금지 — parseFloat 이 `1e-05` 를 파싱하지 못한다. `%.6f` 고정.
        🔴 실패해도 예외를 올리지 않는다. 게인 전송 때문에 로봇이 안 뜨면 안 된다.

        반환: `k?` 응답 원문(str) 또는 None. 이 값이 meta.json 의 fw_tunables 다.
        """
        if not bool(self.get_parameter("send_tunables").value):
            self.get_logger().info("게인 전송 생략 (send_tunables:=false)")
            return None

        sent = []
        for name, key in self.TUNABLE_KEYS:
            val = float(self.get_parameter(name).value)
            try:
                self.ser.write(f"k{key}{val:.6f}\n".encode())   # ← 공백 없음
                self.ser.flush()
            except Exception as e:
                self.get_logger().warn(
                    f"게인 전송 실패 {name}: {e} — 펌웨어 기본값으로 주행한다")
                return None
            time.sleep(0.05)                 # 명령끼리 배치가 뭉치지 않게
            self._read_lines(0.05)           # 에코(# kp=...) 를 비운다
            sent.append(f"{name}={val:g}")
        self.get_logger().info("게인 전송 " + " ".join(sent))

        # 적용 확인 — 이 한 줄이 meta.json 의 fw_tunables ⭐ 가 된다
        try:
            self.ser.write(b"k?\n")          # 🔴 `k ?` 는 동작하지 않는다
            self.ser.flush()
        except Exception as e:
            self.get_logger().warn(f"k? 조회 실패: {e}")
            return None
        for line in self._read_lines(0.5):
            if line.startswith("# kp="):
                self.get_logger().info(f"펌웨어 적용 확인 {line}")
                return line
        self.get_logger().warn(
            "k? 응답 없음 — 게인 적용을 확인하지 못했다 (주행은 계속한다)")
        return None

    # ══════════════════════════════════════════════════════════════
    # 주행로그 tee (docs/주행로그_설계_2026-07-27.md §4-2·§5)
    # ══════════════════════════════════════════════════════════════
    TRACE_SCHEMA = 1

    def _load_session_meta(self):
        """~/drivelog/session.json — 사람이 미리 적어 두는 물리 상태.

        Q1 권고 ①: 노드는 stack_up.sh 가 백그라운드로 띄우므로 대화형 입력이
        불가능하다. 파일 경유가 이 저장소의 기존 패턴이다(teleop_node.py:40).
        """
        path = os.path.join(self.trace_root, "session.json")
        try:
            with open(path, encoding="utf-8") as fp:
                return json.load(fp)
        except FileNotFoundError:
            return {}
        except Exception as e:
            self.get_logger().warn(f"session.json 읽기 실패: {e}")
            return {}

    def _prune_trace_sessions(self, retain_days=14, max_total_mb=2048):
        """Q6 — 14일 + 총량 2GB 이중 상한. 조용히 디스크를 채우지 않는다."""
        try:
            entries = []
            for name in os.listdir(self.trace_root):
                d = os.path.join(self.trace_root, name)
                if not os.path.isdir(d):
                    continue
                size = sum(
                    os.path.getsize(os.path.join(d, f))
                    for f in os.listdir(d)
                    if os.path.isfile(os.path.join(d, f))
                )
                entries.append((os.path.getmtime(d), size, d))
            entries.sort()
            cutoff = time.time() - retain_days * 86400
            total = sum(e[1] for e in entries)
            for mtime, size, d in entries:          # 오래된 것부터
                if not (mtime < cutoff or total > max_total_mb * 1024 * 1024):
                    break
                shutil.rmtree(d, ignore_errors=True)
                total -= size
                self.get_logger().info(f"오래된 주행로그 삭제 {os.path.basename(d)}")
        except Exception as e:
            self.get_logger().warn(f"주행로그 정리 실패: {e}")

    def _open_trace(self):
        """세션 디렉터리를 만들고 trace.csv 를 연다. 실패해도 주행은 계속한다."""
        if not self.trace_root:
            return                                   # trace_dir:='' → 비활성
        meta_in = self._load_session_meta()
        purpose = str(self.get_parameter("purpose").value
                      or meta_in.get("purpose") or "")
        chassis = str(self.get_parameter("chassis_id").value
                      or meta_in.get("chassis_id") or "")
        # ⭐ 이 둘이 없으면 나중에 데이터를 못 믿는다 (설계문서 §4-2)
        if not purpose or not chassis:
            self.get_logger().warn(
                "주행로그 비활성 — purpose·chassis_id 가 비어 있다. "
                f"{os.path.join(self.trace_root, 'session.json')} 에 적거나 "
                "-p purpose:=... -p chassis_id:=... 로 줄 것 (주행은 계속한다)")
            return
        try:
            os.makedirs(self.trace_root, exist_ok=True)
            self._prune_trace_sessions()
            self.trace_dir = os.path.join(
                self.trace_root, time.strftime("%Y-%m-%d_%H%M%S"))
            os.makedirs(self.trace_dir, exist_ok=True)
            self.trace_fp = open(os.path.join(self.trace_dir, "trace.csv"),
                                 "w", encoding="utf-8", buffering=1 << 16)
            # 스키마가 바뀌어도 옛 파일을 읽을 수 있게 첫 줄에 박는다
            self.trace_fp.write(
                f"# schema={self.TRACE_SCHEMA} fw=speed_pid_v1 tele_hz=10 "
                "fields=t_host_ns,T,t_mcu_ms,mode,l_tgt,l_v,l_duty,"
                "r_tgt,r_v,r_duty,l_cnt,r_cnt\n")
        except Exception as e:
            self.get_logger().error(f"주행로그 열기 실패 — 로깅 없이 주행한다: {e}")
            self.trace_fp = None
            return

        try:
            node_md5 = hashlib.md5(
                open(__file__, "rb").read()).hexdigest()
        except Exception:
            node_md5 = None
        self.trace_meta = {
            "schema_version": self.TRACE_SCHEMA,
            "started_iso": datetime.now().astimezone().isoformat(),
            "ended_iso": None, "duration_s": None,
            "purpose": purpose,                            # ⭐
            "chassis_id": chassis,                         # ⭐
            "floor": meta_in.get("floor"),                 # ⭐
            "vbat_start_v": meta_in.get("vbat_start_v"),   # ⭐
            "vbat_end_v": meta_in.get("vbat_end_v"),       # ⭐
            "wheel_note": meta_in.get("wheel_note"),
            "payload_note": meta_in.get("payload_note"),
            "cmd_source": meta_in.get("cmd_source"),
            "fw_banner": self.fw_banner,
            "fw_tunables": self.fw_tunables,               # ⭐ k? 원문
            "tele_hz": 10,
            # 선언 파라미터 전량 dump. get_parameters_by_prefix('') 는 공개 API 다
            # (self._parameters 는 rclpy 내부 속성이라 쓰지 않는다)
            "params": {
                name: p.value
                for name, p in sorted(self.get_parameters_by_prefix("").items())
            },
            "cmdline": " ".join(sys.argv),
            "hostname": socket.gethostname(),
            "node_md5": node_md5,          # ~/calib 은 git repo 가 아니다
            "lines": 0, "t_lines": 0, "event_lines": 0, "bytes": 0,
            "stop_reason": None, "diag_final": None,
        }
        self._started_mono = time.time()
        for key in ("floor", "vbat_start_v", "fw_tunables"):
            if self.trace_meta.get(key) in (None, ""):
                self.get_logger().warn(f"⭐ meta 필드가 비어 있다: {key}")
        self._write_meta()
        self.get_logger().info(f"주행로그 {self.trace_dir}  purpose={purpose}")

    def _write_meta(self):
        try:
            with open(os.path.join(self.trace_dir, "meta.json"),
                      "w", encoding="utf-8") as fp:
                json.dump(self.trace_meta, fp, ensure_ascii=False,
                          indent=2, default=str)
        except Exception as e:
            self.get_logger().warn(f"meta.json 쓰기 실패: {e}")

    def _trace_write(self, arrival_ns, raw):
        """원문 그대로 tee.

        🔑 T 줄만 거르지 **않는다** — '#' 줄이 이벤트(`# auto-stop (deadman)`),
           게인, 펌웨어 배너를 싣는다. 필터링을 **안 해서** 얻는 이득이다.
        🔴 오도메트리 스레드 안이다. 어떤 예외도 밖으로 내보내지 않고,
           실패하면 로깅만 끈다 (재시도하지 않는다 — 50Hz 예외 폭주 방지).
        """
        try:
            self.trace_fp.write(f"{arrival_ns},{raw}\n")
            m = self.trace_meta
            m["lines"] += 1
            m["bytes"] += len(raw) + 21
            if raw.startswith("T,"):
                m["t_lines"] += 1
            else:
                m["event_lines"] += 1
            self.trace_pending += 1
            if self.trace_pending >= 200:      # Q5 — 줄마다 flush 는 낭비다
                self.trace_fp.flush()
                self.trace_pending = 0
        except Exception as e:
            self.get_logger().error(f"주행로그 기록 실패 — 로깅 중단: {e}")
            try:
                self.trace_fp.close()
            except Exception:
                pass
            self.trace_fp = None

    def _close_trace(self, reason):
        if self.trace_fp is None:
            return
        try:
            self.trace_fp.flush()
            self.trace_fp.close()
        except Exception:
            pass
        self.trace_fp = None
        try:
            self.trace_meta["ended_iso"] = datetime.now().astimezone().isoformat()
            self.trace_meta["duration_s"] = round(
                time.time() - self._started_mono, 1)
            self.trace_meta["stop_reason"] = reason
            self.trace_meta["diag_final"] = self.last_diag_values
            self._write_meta()
            self.get_logger().info(
                f"주행로그 종료 {self.trace_dir} "
                f"({self.trace_meta['t_lines']} T줄 / "
                f"{self.trace_meta['event_lines']} 이벤트줄)")
        except Exception as e:
            self.get_logger().warn(f"주행로그 마감 실패: {e}")

    # ── /cmd_vel → 바퀴 목표속도 ────────────────────────────────────
    def on_cmd(self, msg):
        v = max(-self.max_lin, min(self.max_lin, msg.linear.x))
        w = max(-self.max_ang, min(self.max_ang, msg.angular.z))
        half = 0.5 * self.track * w
        
        req_l = v - half
        req_r = v + half
        
        # Saturation Scaling: preserve turning radius if physical limit is exceeded
        max_req = max(abs(req_l), abs(req_r))
        if max_req > self.max_lin:
            scale = self.max_lin / max_req
            req_l *= scale
            req_r *= scale
            
        with self.lock:
            self.tgt_l, self.tgt_r = req_l, req_r
            self.last_cmd_t = time.time()

    # ── 시리얼 수신 → 오도메트리 적분 ───────────────────────────────
    def serial_loop(self):
        while rclpy.ok():
            try:
                raw = self.ser.readline().decode(errors="replace").strip()
            except Exception as e:
                self.get_logger().error(f"시리얼 오류: {e}")
                time.sleep(0.5)
                continue
            # 🔑 arrival_ns 를 T줄 필터 **앞으로** 옮긴다 — '#' 줄에도 시각이 필요하다
            arrival_ns = self.get_clock().now().nanoseconds
            if self.trace_fp is not None and raw:
                self._trace_write(arrival_ns, raw)
            if raw.startswith("# kp="):
                self._handle_tunables_echo(raw)
                continue
            if raw.startswith("L tgt"):
                self.get_logger().info("펌웨어가 사람용 로그를 보내고 있습니다. 기계용(CSV)으로 전환(t 명령)합니다.")
                self.ser.write(b"t\n")
                self.ser.flush()
                continue
            if raw.startswith("IR,"):
                try:
                    parts = raw.split(",")
                    if len(parts) >= 3:
                        body = parts[2].strip()
                        pixels = _decode_ir(body)
                        if pixels is not None:
                            with open("/tmp/ir.json", "w") as f:
                                json.dump({"width": 32, "height": 24,
                                           "pixels": pixels}, f)
                except Exception as exc:
                    self.get_logger().error(f"IR parse error: {exc}")
                continue
            if raw.startswith("E,"):
                self._handle_env_telemetry(raw)
                continue
            if not raw.startswith("T,"):
                continue
            try:
                sample = parse_encoder_telemetry(raw)
            except ValueError:
                with self.lock:
                    self.malformed_telemetry += 1
                continue

            with self.lock:
                self.telemetry_received += 1
                timing = self.mcu_clock.update(sample.acquisition_ms, arrival_ns)
                self.last_arrival_ns = arrival_ns
                if not timing.accepted:
                    self.nonmonotonic_timestamps += 1
                    continue
                self.transport_latency_ms.append(
                    timing.transport_latency_ns / 1_000_000.0
                )
                if timing.rollover:
                    self.mcu_rollovers += 1
                if timing.reset:
                    self.mcu_resets += 1
                    self.prev_lc = sample.left_count
                    self.prev_rc = sample.right_count
                    pose = self.x, self.y, self.th, 0.0, 0.0
                elif self.prev_lc is None:
                    self.prev_lc = sample.left_count
                    self.prev_rc = sample.right_count
                    pose = self.x, self.y, self.th, 0.0, 0.0
                else:
                    if timing.delta_ms is None or timing.delta_ms <= 0:
                        self.nonmonotonic_timestamps += 1
                        continue
                    if timing.delta_ms > self.telemetry_gap_threshold_ms:
                        self.telemetry_gaps += 1
                    dl = (
                        (sample.left_count - self.prev_lc)
                        * self.mm_per_count
                        / 1000.0
                    )
                    dr = (
                        (sample.right_count - self.prev_rc)
                        * self.mm_per_count
                        / 1000.0
                    )
                    dt = timing.delta_ms / 1000.0
                    self.prev_lc = sample.left_count
                    self.prev_rc = sample.right_count
                    self.integrate(dl, dr, dt)
                    pose = self.x, self.y, self.th, self.v, self.w
                self.last_odom_stamp_ns = timing.stamp_ns
                self.odom_published += 1
            self.publish_odom(timing.stamp_ns, *pose)

    def integrate(self, dl, dr, dt):
        """정확 원호 적분. 직선 근사(Euler)는 회전 중 위치를 계속 안쪽으로
        치우치게 만든다 — 매핑에서 폐루프가 안 닫히는 흔한 원인이다."""
        ds = 0.5 * (dl + dr)
        dth = (dr - dl) / self.track
        if abs(dth) < 1e-9:
            self.x += ds * math.cos(self.th)
            self.y += ds * math.sin(self.th)
        else:
            R = ds / dth                       # 곡률 반경
            th2 = self.th + dth
            self.x += R * (math.sin(th2) - math.sin(self.th))
            self.y -= R * (math.cos(th2) - math.cos(self.th))
            self.th = math.atan2(math.sin(th2), math.cos(th2))
        self.v, self.w = ds / dt, dth / dt

    # ── 명령 전송 주기 (오도메트리 발행과 독립) ────────────────────
    def command_tick(self):
        with self.lock:
            expired = time.time() - self.last_cmd_t > self.cmd_timeout
            left, right = (
                (0.0, 0.0) if expired else (self.tgt_l, self.tgt_r)
            )
        try:
            self.ser.write(f"v {left:.4f} {right:.4f}\n".encode())
        except Exception as e:
            self.get_logger().error(f"시리얼 송신 실패: {e}")

    def publish_odom(self, stamp_ns, x, y, th, v, w):
        stamp = Time(nanoseconds=stamp_ns).to_msg()
        q = yaw_to_quat(th)

        o = Odometry()
        o.header.stamp = stamp
        o.header.frame_id = self.odom_frame
        o.child_frame_id = self.base_frame
        o.pose.pose.position.x, o.pose.pose.position.y = x, y
        o.pose.pose.orientation = q
        o.twist.twist.linear.x, o.twist.twist.angular.z = v, w
        # 대각 공분산 — 휠 오도메트리는 회전이 병진보다 훨씬 못 믿을 값이다
        # (윤거가 202~215로 5% 불확실하므로 yaw 분산을 넉넉히 준다)
        o.pose.covariance[0] = o.pose.covariance[7] = 0.002
        o.pose.covariance[35] = 0.05
        o.twist.covariance[0] = 0.002
        o.twist.covariance[35] = 0.05
        self.pub_odom.publish(o)

        t = TransformStamped()
        t.header.stamp = stamp
        t.header.frame_id = self.odom_frame
        t.child_frame_id = self.base_frame
        t.transform.translation.x, t.transform.translation.y = x, y
        t.transform.rotation = q
        self.tf.sendTransform(t)

    def on_scan(self, msg):
        scan_time = Time.from_msg(msg.header.stamp)
        scan_ns = scan_time.nanoseconds
        available = self.tf_buffer.can_transform(
            self.odom_frame,
            self.base_frame,
            scan_time,
            timeout=Duration(seconds=0.0),
        )
        latest_age_ms = None
        if available:
            try:
                latest = self.tf_buffer.lookup_transform(
                    self.odom_frame,
                    self.base_frame,
                    Time(),
                    timeout=Duration(seconds=0.0),
                )
                latest_ns = Time.from_msg(latest.header.stamp).nanoseconds
                latest_age_ms = (scan_ns - latest_ns) / 1_000_000.0
            except Exception:
                available = False
        with self.lock:
            self.scan_count += 1
            if available:
                self.scan_tf_available += 1
            self.last_scan_tf_age_ms = latest_age_ms

    @staticmethod
    def _percentile(values, fraction):
        if not values:
            return 0.0
        ordered = sorted(values)
        index = min(len(ordered) - 1, int((len(ordered) - 1) * fraction))
        return ordered[index]

    def publish_diagnostics(self):
        now_ns = self.get_clock().now().nanoseconds
        with self.lock:
            received = self.telemetry_received
            published = self.odom_published
            malformed = self.malformed_telemetry
            nonmonotonic = self.nonmonotonic_timestamps
            resets = self.mcu_resets
            rollovers = self.mcu_rollovers
            gaps = self.telemetry_gaps
            last_arrival_ns = self.last_arrival_ns
            last_odom_ns = self.last_odom_stamp_ns
            latencies = list(self.transport_latency_ms)
            scan_count = self.scan_count
            scan_tf_available = self.scan_tf_available
            scan_tf_age_ms = self.last_scan_tf_age_ms

        telemetry_age_ms = (
            -1.0
            if last_arrival_ns is None
            else (now_ns - last_arrival_ns) / 1_000_000.0
        )
        odom_age_ms = (
            -1.0
            if last_odom_ns is None
            else (now_ns - last_odom_ns) / 1_000_000.0
        )
        tf_ratio = 1.0 if scan_count == 0 else scan_tf_available / scan_count
        level = DiagnosticStatus.OK
        message = "MCU-timed odometry healthy"
        if last_arrival_ns is None or telemetry_age_ms > self.telemetry_gap_threshold_ms * 2:
            level = DiagnosticStatus.ERROR
            message = "encoder telemetry stale or absent"
        elif gaps or malformed or nonmonotonic or (scan_count and tf_ratio < 0.995):
            level = DiagnosticStatus.WARN
            message = "timing anomalies detected"

        values = {
            "telemetry_received": received,
            "odom_published": published,
            "malformed_telemetry": malformed,
            "nonmonotonic_timestamps": nonmonotonic,
            "mcu_resets": resets,
            "mcu_rollovers": rollovers,
            "telemetry_gaps": gaps,
            "telemetry_age_ms": f"{telemetry_age_ms:.3f}",
            "odom_age_ms": f"{odom_age_ms:.3f}",
            "transport_latency_latest_ms": (
                f"{latencies[-1]:.3f}" if latencies else "n/a"
            ),
            "transport_latency_p50_ms": f"{self._percentile(latencies, 0.50):.3f}",
            "transport_latency_p95_ms": f"{self._percentile(latencies, 0.95):.3f}",
            "scan_tf_available": scan_tf_available,
            "scan_count": scan_count,
            "scan_tf_availability_ratio": f"{tf_ratio:.6f}",
            "latest_scan_to_tf_age_ms": (
                f"{scan_tf_age_ms:.3f}" if scan_tf_age_ms is not None else "n/a"
            ),
        }
        self.last_diag_values = dict(values)   # meta.json 의 diag_final
        status = DiagnosticStatus(
            level=level,
            name="esp32_odometry/timing",
            message=message,
            hardware_id="esp32_base",
            values=[
                KeyValue(key=str(key), value=str(value))
                for key, value in values.items()
            ],
        )
        array = DiagnosticArray()
        array.header.stamp = self.get_clock().now().to_msg()
        array.status = [status]
        self.pub_diag.publish(array)

    def shutdown(self):
        try:
            self.ser.write(b"s\n")
            self.ser.flush()
            time.sleep(0.2)
            self.ser.close()
        except Exception:
            pass
        self._close_trace("shutdown")


def _decode_ir(body):
    """열화상 한 줄을 픽셀 배열(°C×10)로. 못 알아보면 None.

    두 형식을 모두 받는다.
      · **base64** (2,048글자) — 지금 형식. int16 big-endian ×768.
        🔑 부호가 있다. 영하 온도가 제대로 음수로 나온다
      · **hex** (3,072글자) — 옛 형식. 🔴 uint16 로 읽혀서 영하가
        6553.5°C 로 뒤집힌다. 그 버그까지 재현하지 않고 여기서 부호를
        복원한다 — 옛 펌웨어가 물려 있어도 화면이 거짓말하지 않게

    🔴 왜 둘 다 받나: 펌웨어 플래시는 물리 작업이라 Orin 과 동시에 바꿀 수
       없다. 한쪽만 바뀐 구간에서 열화상이 죽으면 안 된다.
       펌웨어가 전부 base64 로 넘어간 뒤 hex 가지는 지워도 된다.
    """
    def _signed(v):
        return v - 65536 if v >= 32768 else v

    if len(body) == 3072:                     # 옛 hex
        try:
            return [_signed(int(body[i:i + 4], 16)) for i in range(0, 3072, 4)]
        except ValueError:
            return None

    if len(body) == 2048:                     # base64
        try:
            data = base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError):
            return None
        if len(data) != 1536:
            return None
        return list(struct.unpack(">768h", data))

    return None


def main():
    rclpy.init()
    node = Esp32Base()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.shutdown()          # 🔴 무슨 일이 있어도 모터를 세운다
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
