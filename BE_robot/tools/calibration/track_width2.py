#!/usr/bin/env python3
"""스캔 상호상관으로 제자리 회전각을 재서 축간거리 측정.

    python3 track_width2.py [목표카운트] [duty]

제자리 회전에서 주변 환경은 정지해 있으므로 스캔 배열은 원형 시프트만 된다.
회전 전후 스캔의 최적 시프트량 = 회전각. 430포인트 전부를 쓰므로
회전량이 얼마든(200도, 300도) 강건하게 측정된다.

    track_width = 2 * (바퀴 이동거리) / Δθ
"""
import math
import os
import re
import subprocess
import sys
import time

import numpy as np
import rclpy
import serial
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan

TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 600
DUTY = int(sys.argv[2]) if len(sys.argv) > 2 else 24
MM_PER_COUNT = 0.16348

PARAMS = ("/home/e101/bbiyong_ros2_ws/install/bbiyong_bringup"
          "/share/bbiyong_bringup/config/ydlidar.yaml")


class Scanner(Node):
    def __init__(self):
        super().__init__("scan_rot")
        self.rows = []
        self.inc = None
        self.n = None
        self.on = False
        self.create_subscription(LaserScan, "/scan", self.cb, qos_profile_sensor_data)

    def cb(self, msg):
        if not self.on:
            return
        r = np.asarray(msg.ranges, dtype=float)
        if self.n is None:
            self.n, self.inc = len(r), msg.angle_increment
        if len(r) != self.n:
            return
        self.rows.append(r)


def snapshot(node, seconds, tag):
    """여러 스캔의 광선별 중앙값 -> 노이즈 억제된 대표 스캔."""
    node.rows = []
    node.on = True
    t0 = time.time()
    while time.time() - t0 < seconds:
        rclpy.spin_once(node, timeout_sec=0.1)
    node.on = False
    if len(node.rows) < 5:
        print("  %s: 스캔 부족 (%d)" % (tag, len(node.rows)))
        return None
    m = np.vstack(node.rows)
    m[~np.isfinite(m)] = np.nan
    with np.errstate(all="ignore"):
        med = np.nanmedian(m, axis=0)
    valid = np.isfinite(med)
    print("  %-6s 유효 %d/%d 광선, 스캔 %d개" % (tag, valid.sum(), med.size, m.shape[0]))
    return med


def best_shift(a, b):
    """b 를 k칸 굴렸을 때 a 와 가장 잘 맞는 k (부분픽셀 보간 포함)."""
    n = a.size
    cost = np.full(n, np.inf)
    for k in range(n):
        bb = np.roll(b, k)
        ok = np.isfinite(a) & np.isfinite(bb)
        if ok.sum() < n * 0.3:
            continue
        cost[k] = np.mean(np.abs(a[ok] - bb[ok]))
    k0 = int(np.argmin(cost))
    if not np.isfinite(cost[k0]):
        return None
    # 최소점 주변 포물선 보간
    cm, c0, cp = cost[(k0 - 1) % n], cost[k0], cost[(k0 + 1) % n]
    delta = 0.0
    if np.isfinite(cm) and np.isfinite(cp):
        den = cm - 2 * c0 + cp
        if abs(den) > 1e-12:
            delta = 0.5 * (cm - cp) / den
            delta = max(-1.0, min(1.0, delta))
    finite = cost[np.isfinite(cost)]
    contrast = (np.median(finite) - c0) / max(np.median(finite), 1e-9)
    return k0 + delta, c0, contrast


def main():
    drv = subprocess.Popen(
        ["bash", "-lc",
         "source /opt/ros/humble/setup.bash;"
         " source ~/ydlidar_ros2_ws/install/setup.bash;"
         " exec ros2 run ydlidar_ros2_driver ydlidar_ros2_driver_node"
         " --ros-args --params-file " + PARAMS],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
    time.sleep(6)
    rclpy.init()
    node = Scanner()
    ser = serial.Serial("/dev/esp32", 115200, timeout=1)
    time.sleep(0.4)
    ser.write(b"s\n"); time.sleep(0.3)
    ser.write(b"r\n"); time.sleep(0.6)
    ser.reset_input_buffer()
    try:
        print("=== 1단계: 회전 전 스캔 ===")
        before = snapshot(node, 4.0, "회전전")
        if before is None:
            raise SystemExit("스캔 실패")

        print()
        print("=== 2단계: 제자리 회전 (목표 %d카운트, duty %d%%) ===" % (TARGET, DUTY))
        cmd = ("f %d\n" % DUTY).encode()
        l = r = 0
        last = 0.0
        t0 = time.time()
        while time.time() - t0 < 30:
            if time.time() - last > 2.0:
                ser.write(cmd); last = time.time()
            m = re.search(r"L=\s*(-?\d+).*?R=\s*(-?\d+)",
                          ser.readline().decode(errors="replace"))
            if m:
                l, r = int(m.group(1)), int(m.group(2))
                if (abs(l) + abs(r)) / 2 >= TARGET:
                    break
        ser.write(b"s\n"); time.sleep(2.5)
        ser.reset_input_buffer(); time.sleep(0.5)
        for _ in range(4):
            m = re.search(r"L=\s*(-?\d+).*?R=\s*(-?\d+)",
                          ser.readline().decode(errors="replace"))
            if m:
                l, r = int(m.group(1)), int(m.group(2))
        print("  정지 후 카운트   좌 %+d   우 %+d" % (l, r))
        time.sleep(1.5)

        print()
        print("=== 3단계: 회전 후 스캔 ===")
        after = snapshot(node, 4.0, "회전후")
        if after is None:
            raise SystemExit("스캔 실패")

        print()
        print("=== 4단계: 상호상관 정합 ===")
        res = best_shift(before, after)
        if res is None:
            raise SystemExit("정합 실패")
        shift, cost, contrast = res
        inc = node.inc
        dtheta = abs(shift) * inc
        if dtheta > math.pi:
            dtheta = 2 * math.pi - dtheta
        avg = (abs(l) + abs(r)) / 2.0
        arc = avg * MM_PER_COUNT
        print("  시프트 %.2f 칸 x %.4f deg/칸" % (shift, math.degrees(inc)))
        print("  잔차 %.1f mm   대비도 %.2f  (0.3 이상이면 정합 신뢰)" % (cost * 1000, contrast))
        print()
        print("=" * 52)
        print("  회전각              %.3f deg  = %.5f rad" % (math.degrees(dtheta), dtheta))
        print("  바퀴 이동거리       %.2f mm   (평균 %.1f카운트)" % (arc, avg))
        print("  좌우 편차           %.2f %%" % (abs(abs(l) - abs(r)) / avg * 100 if avg else 0))
        print("  " + "-" * 48)
        if dtheta > math.radians(5) and contrast > 0.15:
            tw = 2.0 * arc / dtheta
            print("  track_width  = %.2f mm  = %.4f m" % (tw, tw / 1000.0))
        else:
            print("  회전각이 너무 작거나 정합 신뢰도가 낮아 계산 생략")
    finally:
        try:
            ser.write(b"s\n"); ser.close()
        except Exception:
            pass
        node.destroy_node()
        rclpy.shutdown()
        try:
            os.killpg(os.getpgid(drv.pid), 15)
        except Exception:
            pass
        time.sleep(1)


if __name__ == "__main__":
    main()
