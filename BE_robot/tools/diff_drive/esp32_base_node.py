#!/usr/bin/env python3
"""ESP32 하드웨어 브리지 — /cmd_vel 을 받고 /odom + TF 를 낸다.

이 노드가 **ESP32 시리얼 포트의 유일한 소유자**다. bench.py·roam.py 같은
실험 스크립트와 동시에 띄우면 포트 충돌이 난다 (하나만 실행할 것).

    ros2 run 대신 직접:
        python3 esp32_base_node.py --ros-args -p track_width_m:=0.2124

구조
    /cmd_vel (Twist) ─→ 차동 기구학 ─→ `v <L> <R>` ─→ ESP32(속도 PID)
                                                        │
    /odom (Odometry) ←─ 원호 적분 ←─ 엔코더 카운트 ←────┘
    TF: odom→base_link (동적) · base_link→laser_frame (정적)

🔒 부호: speed_pid 펌웨어가 좌우 거울대칭을 이미 흡수했다(§D).
   따라서 여기서는 **양쪽 다 + = 전진**이며 right_wheel_direction 같은
   반전 파라미터를 두지 않는다. 두면 이중 반전이 된다.
"""
import hashlib
import json
import math
import os
import shutil
import socket
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
        self.declare_parameter("track_width_m", 0.2091)
        self.declare_parameter("max_linear_mps", 0.30)
        self.declare_parameter("max_angular_rps", 1.2)
        self.declare_parameter("cmd_timeout_sec", 0.5)
        self.declare_parameter("publish_rate_hz", 30.0)
        self.declare_parameter("telemetry_gap_threshold_ms", 250)
        self.declare_parameter("diagnostics_rate_hz", 1.0)
        self.declare_parameter("scan_topic", "/scan")
        self.declare_parameter("odom_frame", "odom")
        self.declare_parameter("base_frame", "base_link")
        self.declare_parameter("laser_frame", "laser_frame")
        # [실측 2026-07-26] 제자리 회전 중 벽거리 사인파 적합. 2회 평균.
        self.declare_parameter("laser_x", 0.0597)
        self.declare_parameter("laser_y", -0.0051)
        # 🔒 +4.31° = +0.0752 rad — 2026-07-26 laser_yaw_calib.py 3회 평균
        #    (전진 +4.52/+4.69, 후진 +3.71, 산포 ±0.5°).
        #    평면 2개 + 직진 이동벡터 방식. 전진·후진이 일치하므로 짝짓기
        #    계통오차가 아니라 실제 마운트 오차다.
        #    ⚠️ 라이다 마운트를 다시 건드리면 이 값은 무효 — 재측정할 것.
        self.declare_parameter("laser_yaw", 0.0752)

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
        self.ser.reset_input_buffer()
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

        self.reader = threading.Thread(target=self.serial_loop, daemon=True)
        self.reader.start()
        # Command/watchdog output stays periodic. Odometry is emitted only when
        # encoder telemetry arrives, using the MCU acquisition timestamp.
        self.create_timer(1.0 / command_rate_hz, self.command_tick)
        self.create_timer(1.0 / diagnostics_rate_hz, self.publish_diagnostics)

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
        with self.lock:
            self.tgt_l, self.tgt_r = v - half, v + half
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
