#!/usr/bin/env python3
"""순수 구독자 — /scan 원시값을 그대로 본다. 드라이버를 띄우지 않는다.

scan_profile.py 는 자기 드라이버를 subprocess 로 띄우기 때문에,
이미 드라이버가 떠 있으면 /scan 에 퍼블리셔가 둘이 되어 데이터가 섞인다.
이 스크립트는 구독만 하므로 그 혼선이 없다.
"""
import sys

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan


class Raw(Node):
    def __init__(self, n):
        super().__init__("scan_raw")
        self.n, self.msgs = n, []
        self.create_subscription(LaserScan, "/scan", self.cb, qos_profile_sensor_data)

    def cb(self, msg):
        if len(self.msgs) < self.n:
            self.msgs.append(msg)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    rclpy.init()
    node = Raw(n)
    for _ in range(n * 60):
        rclpy.spin_once(node, timeout_sec=0.1)
        if len(node.msgs) >= n:
            break
    node.destroy_node()
    rclpy.shutdown()

    if not node.msgs:
        print("스캔 없음")
        return 1

    print(f"퍼블리셔 확인용 — 스캔 {len(node.msgs)}개 수집")
    sizes = {len(m.ranges) for m in node.msgs}
    print(f"  포인트 수 종류: {sorted(sizes)}  "
          f"{'← 2종류면 퍼블리셔가 둘이다' if len(sizes) > 1 else '(단일)'}")
    m0 = node.msgs[0]
    print(f"  frame={m0.header.frame_id} angle={np.degrees(m0.angle_min):.1f}"
          f"~{np.degrees(m0.angle_max):.1f}° range={m0.range_min}~{m0.range_max}")

    for k, msg in enumerate(node.msgs[:3]):
        r = np.asarray(msg.ranges, dtype=float)
        a = np.degrees(msg.angle_min + np.arange(len(r)) * msg.angle_increment)
        ok = np.isfinite(r) & (r > msg.range_min) & (r < msg.range_max)
        a, r = a[ok], r[ok]
        idx = np.argsort(r)[:10]
        print(f"\n  [스캔 {k}] 유효 {ok.sum()}점 · 최소 10개:")
        print("   " + "  ".join(f"{a[i]:+.1f}°/{r[i]*1000:.0f}mm" for i in idx))

    # 창 덤프: 특정 방위 주변이 정말 평면인지 눈으로 본다.
    #   scan_raw.py <스캔수> <중심°> <반폭°>
    if len(sys.argv) > 2:
        c = float(sys.argv[2])
        half = float(sys.argv[3]) if len(sys.argv) > 3 else 50.0
        msg = node.msgs[0]
        r = np.asarray(msg.ranges, dtype=float)
        a = np.degrees(msg.angle_min + np.arange(len(r)) * msg.angle_increment)
        ok = np.isfinite(r) & (r > msg.range_min) & (r < msg.range_max)
        a, r = a[ok], r[ok] * 1000.0
        d = (a - c + 180.0) % 360.0 - 180.0
        sel = np.abs(d) <= half
        a, r, d = a[sel], r[sel], d[sel]
        order = np.argsort(d)
        # 평면 가정: r = d_perp / cos(방위 - 법선). 중심을 법선으로 가정해 비교
        print(f"\n  [창 덤프] 중심 {c:+.1f}° ±{half:.0f}°  "
              f"— 평면이면 r·cos(Δ)가 일정해야 한다")
        print(f"   {'방위°':>8} {'Δ°':>7} {'r(mm)':>8} {'r·cosΔ':>9}")
        for i in order[::2]:
            print(f"   {a[i]:>8.1f} {d[i]:>7.1f} {r[i]:>8.0f} "
                  f"{r[i]*np.cos(np.radians(d[i])):>9.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
