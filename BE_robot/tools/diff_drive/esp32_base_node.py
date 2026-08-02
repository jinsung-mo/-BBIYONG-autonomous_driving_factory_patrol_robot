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
import math
import threading
import time
from collections import deque

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
        # The LiDAR is mounted facing backward. Preserve the measured +4.31 deg
        # mounting correction, then add 180 deg:
        #   normalize(+0.0752 + pi) = -3.06639 rad (-175.69 deg)
        # This is a physical base_link -> laser_frame rotation. Do not express
        # it by changing the driver's inverted/reversion scan-order settings.
        # Re-run laser_yaw_calib.py if the mount is moved again.
        self.declare_parameter("laser_yaw", -3.06639)

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

        self.reader = threading.Thread(target=self.serial_loop, daemon=True)
        self.reader.start()
        # Command/watchdog output stays periodic. Odometry is emitted only when
        # encoder telemetry arrives, using the MCU acquisition timestamp.
        self.create_timer(1.0 / command_rate_hz, self.command_tick)
        self.create_timer(1.0 / diagnostics_rate_hz, self.publish_diagnostics)

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
            if not raw.startswith("T,"):
                continue
            try:
                sample = parse_encoder_telemetry(raw)
            except ValueError:
                with self.lock:
                    self.malformed_telemetry += 1
                continue

            arrival_ns = self.get_clock().now().nanoseconds
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
