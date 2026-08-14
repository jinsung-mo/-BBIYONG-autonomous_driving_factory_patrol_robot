#!/usr/bin/env python3
"""오도메트리 검증 — /odom 의 yaw 를 라이다 실측 회전과 대조한다.

    python3 odom_check.py [회전초] [각속도 rad/s]

무엇을 가르는가
  현재 윤거는 202(§K) vs 212(2026-07-26 재측정)로 확정되지 않았다.
  제자리 회전에서 /odom 이 말하는 회전량과 **벽 법선이 실제로 돈 각도**를
  비교하면, 비율이 곧 윤거 배율이다:

      track_참값 = track_설정 × (yaw_odom / yaw_lidar)

  벽 법선의 방위각은 라이다의 병진에 오염되지 않으므로(평면의 법선은
  관측점을 옮겨도 같다) 이 비교는 라이다 오프셋과 무관하게 성립한다.

⚠️ esp32_base_node 가 떠 있어야 한다 (이 스크립트는 /cmd_vel 만 낸다).
"""
import math
import sys
import time

import numpy as np
import rclpy
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import LaserScan

sys.path.insert(0, "/home/e101/calib")
from wall_measure import ransac_line          # noqa: E402

SECTOR_DEG = 55.0
MIN_POINTS = 30


class Checker(Node):
    def __init__(self):
        super().__init__("odom_check")
        self.scan = None
        self.yaw = None
        self.rng = np.random.default_rng(42)
        self.create_subscription(LaserScan, "/scan", self._scan, qos_profile_sensor_data)
        self.create_subscription(
            Odometry, "/odom", self._odom,
            QoSProfile(reliability=ReliabilityPolicy.RELIABLE, depth=10))
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)

    def _scan(self, m):
        self.scan = m

    def _odom(self, m):
        q = m.pose.pose.orientation
        self.yaw = math.atan2(2.0 * (q.w * q.z), 1.0 - 2.0 * (q.z * q.z))

    def wall_normal(self):
        m = self.scan
        if m is None:
            return None
        n = len(m.ranges)
        a = m.angle_min + np.arange(n) * m.angle_increment
        r = np.asarray(m.ranges, dtype=float)
        ok = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
        a, r = a[ok], r[ok]
        if len(r) < MIN_POINTS:
            return None
        th0 = a[int(np.argmin(r))]
        d = np.arctan2(np.sin(a - th0), np.cos(a - th0))
        sel = np.abs(d) <= math.radians(SECTOR_DEG)
        if sel.sum() < MIN_POINTS:
            return None
        x, y = r[sel] * np.cos(a[sel]), r[sel] * np.sin(a[sel])
        keep = ransac_line(x, y, self.rng)
        if keep is None or keep.sum() < MIN_POINTS:
            return None
        cx, cy = x[keep].mean(), y[keep].mean()
        _u, _s, vt = np.linalg.svd(
            np.column_stack([x[keep] - cx, y[keep] - cy]), full_matrices=False)
        nx, ny = vt[1]
        if nx * cx + ny * cy < 0:
            nx, ny = -nx, -ny
        res = np.abs((x[keep] - cx) * nx + (y[keep] - cy) * ny)
        if res.std() > 0.006:
            return None
        return math.atan2(ny, nx)

    def send(self, wz):
        t = Twist()
        t.angular.z = wz
        self.pub.publish(t)


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 14.0
    wz = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6

    rclpy.init()
    node = Checker()
    t0 = time.time()
    while (node.scan is None or node.yaw is None) and time.time() - t0 < 6.0:
        rclpy.spin_once(node, timeout_sec=0.05)
    if node.scan is None or node.yaw is None:
        print("스캔 또는 오도메트리 없음 — esp32_base_node 와 라이다 확인")
        return 1

    odoms, lasers = [], []
    t0 = time.time()
    try:
        while time.time() - t0 < secs:
            node.send(wz)
            rclpy.spin_once(node, timeout_sec=0.05)
            phi = node.wall_normal()
            if phi is not None and node.yaw is not None:
                odoms.append(node.yaw)
                lasers.append(phi)
            time.sleep(0.04)
    finally:
        for _ in range(6):
            node.send(0.0)
            time.sleep(0.05)

    if len(odoms) < 30:
        print(f"표본 부족 ({len(odoms)}) — 벽이 계속 보이는 자리에서 재시도")
        node.destroy_node(); rclpy.shutdown(); return 1

    o = np.unwrap(np.array(odoms))
    l = np.unwrap(np.array(lasers))
    do, dl = o[-1] - o[0], l[-1] - l[0]

    print(f"표본 {len(odoms)}개")
    print(f"  /odom  누적 yaw   {math.degrees(do):+9.1f}°")
    print(f"  라이다 실제 회전  {math.degrees(dl):+9.1f}°   ← 참값")
    if abs(dl) < math.radians(90):
        print("  회전이 90° 미만이라 비교가 부정확하다. 시간을 늘려 재측정.")
    else:
        ratio = do / dl
        print(f"  비율 odom/실제    {ratio:9.4f}   (1.0 이 이상적)")
        print(f"  회전 오차         {abs(ratio-1)*100:8.1f} %")
        # track_참 = track_설정 × (yaw_odom / yaw_lidar)
        for name, tw in (("현재 설정 0.2124", 0.2124), ("§K 0.2018", 0.2018)):
            print(f"    {name} 기준 → 참 윤거 {tw*ratio*1000:7.1f} mm")
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
