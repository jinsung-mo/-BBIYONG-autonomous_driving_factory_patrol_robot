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

import rclpy
import serial
from geometry_msgs.msg import Twist, TransformStamped, Quaternion
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from tf2_ros import TransformBroadcaster, StaticTransformBroadcaster


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

        g = lambda k: self.get_parameter(k).value            # noqa: E731
        self.mm_per_count = float(g("mm_per_count"))
        self.track = float(g("track_width_m"))
        self.max_lin = float(g("max_linear_mps"))
        self.max_ang = float(g("max_angular_rps"))
        self.cmd_timeout = float(g("cmd_timeout_sec"))
        self.odom_frame = g("odom_frame")
        self.base_frame = g("base_frame")

        # ── 상태 ────────────────────────────────────────────────────
        self.x = self.y = self.th = 0.0
        self.v = self.w = 0.0
        self.tgt_l = self.tgt_r = 0.0
        self.last_cmd_t = 0.0
        self.prev_lc = self.prev_rc = None
        self.prev_t = None
        self.lock = threading.Lock()

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
        self.tf = TransformBroadcaster(self)

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
        self.create_timer(1.0 / float(g("publish_rate_hz")), self.tick)

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
            p = raw.split(",")
            if len(p) != 11:
                continue
            try:
                lc, rc = int(p[9]), int(p[10])
            except ValueError:
                continue
            now = time.time()
            with self.lock:
                if self.prev_lc is None:
                    self.prev_lc, self.prev_rc, self.prev_t = lc, rc, now
                    continue
                dl = (lc - self.prev_lc) * self.mm_per_count / 1000.0
                dr = (rc - self.prev_rc) * self.mm_per_count / 1000.0
                dt = now - self.prev_t
                self.prev_lc, self.prev_rc, self.prev_t = lc, rc, now
                if dt <= 0.0:
                    continue
                self.integrate(dl, dr, dt)

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

    # ── 주기 발행 ───────────────────────────────────────────────────
    def tick(self):
        with self.lock:
            expired = time.time() - self.last_cmd_t > self.cmd_timeout
            l, r = (0.0, 0.0) if expired else (self.tgt_l, self.tgt_r)
            x, y, th, v, w = self.x, self.y, self.th, self.v, self.w
        try:
            self.ser.write(f"v {l:.4f} {r:.4f}\n".encode())
        except Exception as e:
            self.get_logger().error(f"시리얼 송신 실패: {e}")

        stamp = self.get_clock().now().to_msg()
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
