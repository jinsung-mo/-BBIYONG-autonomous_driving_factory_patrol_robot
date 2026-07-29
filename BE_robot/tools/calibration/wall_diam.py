#!/usr/bin/env python3
"""라이다 벽 거리차로 바퀴 유효지름 측정.

    python3 wall_diam.py [목표카운트] [duty]

절차: 벽까지 거리 d1 측정 -> 전진 -> 거리 d2 측정 -> 이동거리 = d1 - d2.
라이다 원점이 어디든 뺄셈에서 상쇄되므로 오프셋 오차는 무관하다.
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

TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
DUTY = int(sys.argv[2]) if len(sys.argv) > 2 else 15

CPR = 1197.0
NOMINAL_D = 0.085          # 명목 바퀴 지름 (주행거리 예상용)
SECTOR   = math.radians(12)   # 벽 피팅 반각
CENTER   = math.radians(float(sys.argv[3]) if len(sys.argv) > 3 else 0.0)  # 벽 방향(도)
MIN_WALL = 0.35               # 이보다 가까운 반사는 무시(사람 손/자기 몸)
FRONT_OVERHANG = 0.21      # 라이다 중심 -> 차량 최전방(카메라)
MIN_GAP = 0.25             # 정지 후 카메라와 벽 사이 최소 여유
COAST = 0.15               # 정지 명령 후 관성 주행 여유

PARAMS = ("/home/e101/bbiyong_ros2_ws/install/bbiyong_bringup"
          "/share/bbiyong_bringup/config/ydlidar.yaml")


class WallMeter(Node):
    def __init__(self):
        super().__init__("wall_meter")
        self.buf = []
        self.res = []
        self.npts = []
        self.on = False
        self.create_subscription(LaserScan, "/scan", self.cb, qos_profile_sensor_data)

    def cb(self, msg):
        if not self.on:
            return
        rng = np.asarray(msg.ranges, dtype=float)
        ang = msg.angle_min + np.arange(len(rng)) * msg.angle_increment
        ok = np.isfinite(rng) & (rng > msg.range_min) & (rng < msg.range_max)
        if ok.sum() < 20:
            return
        r, a = rng[ok], ang[ok]
        d_ang = np.angle(np.exp(1j * (a - CENTER)))    # 지정 방향 기준 -pi..pi
        sel = (np.abs(d_ang) < SECTOR) & (r > MIN_WALL)
        if sel.sum() < 8:
            return
        x = r[sel] * np.cos(a[sel])
        y = r[sel] * np.sin(a[sel])
        mx, my = x.mean(), y.mean()
        # 총최소제곱: 직선까지의 수직거리를 최소화 -> 벽 각도에 무관
        _, _, vt = np.linalg.svd(np.column_stack([x - mx, y - my]))
        nx, ny = vt[1]
        resid = np.sqrt(np.mean((nx * (x - mx) + ny * (y - my)) ** 2))
        self.res.append(resid)
        self.npts.append(int(sel.sum()))
        self.buf.append(abs(nx * mx + ny * my))


def measure(node, seconds, tag):
    node.buf = []
    node.res = []
    node.npts = []
    node.on = True
    t0 = time.time()
    while time.time() - t0 < seconds:
        rclpy.spin_once(node, timeout_sec=0.1)
    node.on = False
    d = np.asarray(node.buf)
    if d.size < 5:
        print("  %s: 스캔 부족 (%d개)" % (tag, d.size))
        return None
    print("  %-6s %.4f m   (표준편차 %.1f mm, 스캔 %d개, 섹터 %d점, 평면잔차 %.1f mm)"
          % (tag, d.mean(), d.std() * 1000, d.size,
             int(np.median(node.npts)), float(np.median(node.res)) * 1000))
    return float(d.mean())


def read_counts(ser, tries=4):
    l = r = 0
    for _ in range(tries):
        m = re.search(r"L=\s*(-?\d+).*?R=\s*(-?\d+)",
                      ser.readline().decode(errors="replace"))
        if m:
            l, r = int(m.group(1)), int(m.group(2))
    return l, r


def main():
    drv = subprocess.Popen(
        ["bash", "-lc",
         "source /opt/ros/humble/setup.bash;"
         " source ~/ydlidar_ros2_ws/install/setup.bash;"
         " exec ros2 run ydlidar_ros2_driver ydlidar_ros2_driver_node"
         " --ros-args --params-file " + PARAMS],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid)
    time.sleep(6)

    rclpy.init()
    node = WallMeter()
    ser = serial.Serial("/dev/esp32", 115200, timeout=1)
    time.sleep(0.4)
    ser.write(b"s\n")
    time.sleep(0.3)
    ser.write(b"r\n")
    time.sleep(0.6)
    ser.reset_input_buffer()

    try:
        print("=== 1단계: 출발 위치에서 벽까지 ===")
        d1 = measure(node, 4.0, "출발")
        if d1 is None:
            raise SystemExit("라이다 측정 실패 — 벽이 보이는지 확인하세요")

        plan = TARGET / CPR * math.pi * NOMINAL_D
        clear = d1 - FRONT_OVERHANG
        max_trav = clear - MIN_GAP - COAST
        max_cnt = max(int(max_trav / (math.pi * NOMINAL_D) * CPR), 0)
        print("  카메라~벽 여유 %.3f m  ->  안전 최대 주행 %.3f m (약 %d카운트)"
              % (clear, max_trav, max_cnt))

        if plan > max_trav:
            print()
            print("중단: %d카운트(%.2f m)는 안전 한계를 넘습니다." % (TARGET, plan))
            print("  -> python3 /tmp/wall_diam.py %d   로 다시 실행하거나" % max_cnt)
            print("  -> 로봇을 벽에서 더 떨어뜨리세요 (멀수록 정확)")
            raise SystemExit(1)

        print()
        print("=== 2단계: 주행 (목표 %d카운트, 예상 %.2f m) ===" % (TARGET, plan))
        cmd = ("d %d -%d\n" % (DUTY, DUTY)).encode()
        l = r = 0
        last = 0.0
        t0 = time.time()
        while time.time() - t0 < 40:
            if time.time() - last > 2.0:
                ser.write(cmd)
                last = time.time()
            m = re.search(r"L=\s*(-?\d+).*?R=\s*(-?\d+)",
                          ser.readline().decode(errors="replace"))
            if m:
                l, r = int(m.group(1)), int(m.group(2))
                if (abs(l) + abs(r)) / 2 >= TARGET:
                    break
        ser.write(b"s\n")
        time.sleep(2.0)
        ser.reset_input_buffer()
        time.sleep(0.5)
        l, r = read_counts(ser)
        print("  정지 후 카운트   좌 %+d   우 %+d" % (l, r))
        time.sleep(1.5)

        print()
        print("=== 3단계: 도착 위치에서 벽까지 ===")
        d2 = measure(node, 4.0, "도착")
        if d2 is None:
            raise SystemExit("라이다 측정 실패")

        avg = (abs(l) + abs(r)) / 2.0
        rev = avg / CPR
        dist = d1 - d2
        print()
        print("=" * 48)
        print("  이동거리 (라이다)   %.4f m  = %.1f mm" % (dist, dist * 1000))
        print("  바퀴 회전수         %.4f 회" % rev)
        print("  좌우 편차           %.2f %%"
              % (abs(abs(l) - abs(r)) / avg * 100 if avg else 0.0))
        print("  " + "-" * 44)
        if rev > 0.05 and dist > 0.02:
            print("  유효지름   = %.2f mm   (명목 85.00)" % (dist * 1000 / (rev * math.pi)))
            print("  유효원주   = %.2f mm   (명목 267.04)" % (dist * 1000 / rev))
            print("  mm/카운트  = %.5f     (명목 0.22309)" % (dist * 1000 / avg))
        else:
            print("  이동거리 또는 회전수가 너무 작아 계산 생략")
    finally:
        try:
            ser.write(b"s\n")
            ser.close()
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
