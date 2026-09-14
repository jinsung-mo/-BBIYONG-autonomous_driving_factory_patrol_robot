#!/usr/bin/env python3
"""반응형 탐색 주행 (ROS 버전) — /cmd_vel 로 명령한다.

roam.py 는 ESP32 시리얼을 직접 열지만, 매핑 중에는 esp32_base_node 가
포트를 독점하므로 그 방식이 안 된다. 이 버전은 /cmd_vel 만 낸다.

    python3 roam_ros.py [주행초] [속도] [각속도]

매핑용으로 바뀐 점
  · 각속도를 낮게 잡는다 — 라이다 1스캔이 86ms라 0.6 rad/s면 스캔 중
    2.97°(약 4빈) 모션 왜곡이 생긴다. 0.3 rad/s면 절반으로 준다.
  · 회전 후 잠깐 멈춘다 — 정지 상태 스캔이 있어야 노드 정합이 안정적이다.
"""
import math
import sys
import time

import numpy as np
import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan

CLEAR_M = 0.60          # 이보다 트여야 직진
RESUME_M = 0.75         # 회전 종료 판정 (히스테리시스)
CONE_DEG = 45.0
CTRL_HZ = 10.0


class Roam(Node):
    def __init__(self, fwd_deg=0.0):
        super().__init__("roam_ros")
        self.scan = None
        self.fwd = math.radians(fwd_deg)
        self.create_subscription(LaserScan, "/scan", self._cb, qos_profile_sensor_data)
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)

    def _cb(self, m):
        self.scan = m

    def polar(self):
        m = self.scan
        n = len(m.ranges)
        a = m.angle_min + np.arange(n) * m.angle_increment
        r = np.asarray(m.ranges, dtype=float)
        ok = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
        return a[ok], r[ok]

    def cone_min(self, heading, half=CONE_DEG):
        a, r = self.polar()
        if len(r) == 0:
            return float("inf")
        d = np.arctan2(np.sin(a - heading), np.cos(a - heading))
        sel = np.abs(d) <= math.radians(half)
        return float(r[sel].min()) if sel.any() else float("inf")

    def best_dir(self, half=30.0):
        a, r = self.polar()
        if len(r) == 0:
            return self.fwd, 0.0
        bh, bv = self.fwd, -1.0
        for deg in range(-180, 180, 10):
            h = math.radians(deg)
            d = np.arctan2(np.sin(a - h), np.cos(a - h))
            sel = np.abs(d) <= math.radians(half)
            if not sel.any():
                continue
            v = float(r[sel].min())
            if v > bv:
                bh, bv = h, v
        return bh, bv

    def cmd(self, vx, wz):
        t = Twist()
        t.linear.x, t.angular.z = vx, wz
        self.pub.publish(t)


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0
    vx = float(sys.argv[2]) if len(sys.argv) > 2 else 0.11
    wz = float(sys.argv[3]) if len(sys.argv) > 3 else 0.30

    rclpy.init()
    node = Roam()
    t0 = time.time()
    while node.scan is None and time.time() - t0 < 6.0:
        rclpy.spin_once(node, timeout_sec=0.05)
    if node.scan is None:
        print("스캔 없음")
        return 1

    state, turn_sign, n_turn = "FWD", 1.0, 0
    t0 = time.time()
    try:
        while time.time() - t0 < secs:
            rclpy.spin_once(node, timeout_sec=0.02)
            if node.scan is None:
                continue
            ahead = node.cone_min(node.fwd)

            if state == "FWD":
                if ahead < CLEAR_M:
                    node.cmd(0.0, 0.0)
                    h, v = node.best_dir()
                    turn_sign = 1.0 if math.atan2(
                        math.sin(h - node.fwd), math.cos(h - node.fwd)) > 0 else -1.0
                    state = "TURN"
                    n_turn += 1
                    print(f"[{time.time()-t0:5.1f}s] 전방 {ahead*1000:.0f}mm "
                          f"→ 회전 (목표 {math.degrees(h):+.0f}°, 트임 {v*1000:.0f}mm)")
                    time.sleep(0.4)          # 정지 스캔 확보
                    continue
                node.cmd(vx, 0.0)
            else:
                if ahead > RESUME_M:
                    node.cmd(0.0, 0.0)
                    state = "FWD"
                    print(f"[{time.time()-t0:5.1f}s] 전방 {ahead*1000:.0f}mm 확보 → 직진")
                    time.sleep(0.5)          # 정지 스캔 확보 (노드 정합 안정화)
                    continue
                node.cmd(0.0, turn_sign * wz)
            time.sleep(1.0 / CTRL_HZ)
    except KeyboardInterrupt:
        print("\n중단")
    finally:
        for _ in range(8):                   # 확실히 멈춘다
            node.cmd(0.0, 0.0)
            time.sleep(0.05)

    print(f"  회전 {n_turn}회 · {time.time()-t0:.0f}초")
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
