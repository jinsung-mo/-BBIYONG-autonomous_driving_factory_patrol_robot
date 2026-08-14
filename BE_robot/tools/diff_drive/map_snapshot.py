#!/usr/bin/env python3
"""/map (OccupancyGrid) 한 장을 받아 PGM + 메타로 저장한다.

Orin 에는 matplotlib 이 없을 수 있으므로 **의존성 없는 PGM**으로 떨군다.
그림 렌더링은 받아서 PC 에서 한다.

    python3 map_snapshot.py [출력경로없이_접두어]
"""
import sys
import time

import numpy as np
import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy, HistoryPolicy


class Snap(Node):
    def __init__(self):
        super().__init__("map_snapshot")
        self.msg = None
        # /map 은 transient_local(latched)로 발행된다 — 이걸 안 맞추면
        # 다음 갱신(map_update_interval)까지 아무것도 안 온다.
        qos = QoSProfile(reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.TRANSIENT_LOCAL,
                         history=HistoryPolicy.KEEP_LAST, depth=1)
        self.create_subscription(OccupancyGrid, "/map", self._cb, qos)

    def _cb(self, m):
        self.msg = m


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else "/tmp/orincar_map"
    rclpy.init()
    node = Snap()
    t0 = time.time()
    while node.msg is None and time.time() - t0 < 20.0:
        rclpy.spin_once(node, timeout_sec=0.1)
    m = node.msg
    node.destroy_node()
    rclpy.shutdown()
    if m is None:
        print("지도를 못 받았다 (/map)")
        return 1

    w, h = m.info.width, m.info.height
    res = m.info.resolution
    ox, oy = m.info.origin.position.x, m.info.origin.position.y
    grid = np.asarray(m.data, dtype=np.int16).reshape(h, w)

    known = int((grid >= 0).sum())
    occ = int((grid > 50).sum())
    free = int(((grid >= 0) & (grid <= 50)).sum())

    # PGM: 미지=205(회색), 자유=254(흰), 점유=0(검) — ROS map_server 관례
    img = np.full((h, w), 205, dtype=np.uint8)
    img[(grid >= 0) & (grid <= 50)] = 254
    img[grid > 50] = 0
    img = np.flipud(img)                     # PGM 은 위→아래, 맵은 아래→위

    pgm = f"{prefix}.pgm"
    with open(pgm, "wb") as f:
        f.write(b"P5\n")
        f.write(f"# OrinCar slam_toolbox  res={res} origin=({ox},{oy})\n".encode())
        f.write(f"{w} {h}\n255\n".encode())
        f.write(img.tobytes())
    with open(f"{prefix}.yaml", "w") as f:
        f.write(f"image: {pgm.split('/')[-1]}\nresolution: {res}\n"
                f"origin: [{ox}, {oy}, 0.0]\nnegate: 0\n"
                f"occupied_thresh: 0.65\nfree_thresh: 0.196\n")

    print(f"지도 {w}×{h} · {res*1000:.0f}mm/셀 · 원점({ox:.2f}, {oy:.2f})")
    print(f"  실제 크기 {w*res:.2f} × {h*res:.2f} m")
    print(f"  탐색된 셀 {known:,} ({known/(w*h)*100:.1f}%)  "
          f"자유 {free:,}  점유 {occ:,}")
    print(f"  자유 면적 {free*res*res:.2f} m²  ← 실제로 돌아다닌 공간")
    print(f"저장 {pgm}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
