#!/usr/bin/env python3
"""라이다가 사방으로 무엇을 보고 있는지 각도 구간별로 요약.

로봇 자기 몸(self-occlusion)과 실제 벽을 구분하기 위한 진단용.
"""
import math
import os
import subprocess
import sys
import time

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan

SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
NBIN = 24                       # 15도 구간 24개
PARAMS = ("/home/e101/bbiyong_ros2_ws/install/bbiyong_bringup"
          "/share/bbiyong_bringup/config/ydlidar.yaml")


class Profiler(Node):
    def __init__(self):
        super().__init__("scan_profiler")
        self.rows = []
        self.meta = None
        self.create_subscription(LaserScan, "/scan", self.cb, qos_profile_sensor_data)

    def cb(self, msg):
        rng = np.asarray(msg.ranges, dtype=float)
        if self.meta is None:
            self.meta = (msg.header.frame_id, msg.angle_min, msg.angle_max,
                         msg.angle_increment, msg.range_min, msg.range_max, len(rng))
        if self.rows and rng.size != self.rows[0].size:
            return          # 스캔마다 포인트 수가 달라질 때가 있다
        self.rows.append(rng)


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
    node = Profiler()
    try:
        t0 = time.time()
        while time.time() - t0 < SECONDS:
            rclpy.spin_once(node, timeout_sec=0.1)
        if not node.rows:
            print("스캔 수신 없음")
            return
        fid, amin, amax, ainc, rmin, rmax, n = node.meta
        data = np.vstack(node.rows)
        ang = amin + np.arange(n) * ainc
        print("frame_id=%s  포인트 %d  범위 %.2f~%.2f m  스캔 %d개"
              % (fid, n, rmin, rmax, data.shape[0]))
        print()
        print("  각도구간        유효율   최소     중앙값    최대     안정성")
        print("  " + "-" * 62)
        edges = np.linspace(-math.pi, math.pi, NBIN + 1)
        for i in range(NBIN):
            sel = (ang >= edges[i]) & (ang < edges[i + 1])
            if not sel.any():
                continue
            blk = data[:, sel]
            ok = np.isfinite(blk) & (blk > rmin) & (blk < rmax)
            if ok.sum() == 0:
                print("  %+4.0f~%+4.0f deg     0%%        -        -        -         -"
                      % (math.degrees(edges[i]), math.degrees(edges[i + 1])))
                continue
            v = blk[ok]
            # 같은 방향을 시간에 따라 봤을 때 얼마나 흔들리는지
            per_ray = []
            for j in range(blk.shape[1]):
                col = blk[:, j]
                c = col[np.isfinite(col) & (col > rmin) & (col < rmax)]
                if c.size >= 3:
                    per_ray.append(c.std())
            jitter = np.median(per_ray) * 1000 if per_ray else float("nan")
            print("  %+4.0f~%+4.0f deg  %5.0f%%  %7.3f  %7.3f  %7.3f   %6.1f mm"
                  % (math.degrees(edges[i]), math.degrees(edges[i + 1]),
                     ok.mean() * 100, v.min(), np.median(v), v.max(), jitter))
        print()
        print("  읽는 법:")
        print("   · 유효율 0%%  = 그 방향은 아무것도 안 잡힘(빈 공간 또는 10m 초과)")
        print("   · 안정성 수 mm = 고정 물체. 수십 mm = 매 스캔 다른 걸 잡는 중")
        print("   · 최소거리가 0.3m 미만인 구간 = 로봇 자기 몸일 가능성")
    finally:
        node.destroy_node()
        rclpy.shutdown()
        try:
            os.killpg(os.getpgid(drv.pid), 15)
        except Exception:
            pass
        time.sleep(1)


if __name__ == "__main__":
    main()
