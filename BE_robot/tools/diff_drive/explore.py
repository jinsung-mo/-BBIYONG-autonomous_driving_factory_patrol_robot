#!/usr/bin/env python3
"""프런티어 탐사 주행 — 지도를 보고 **아직 안 본 곳**으로 간다.

    python3 explore.py [주행초] [속도] [각속도]

patrol.py 와 무엇이 다른가
  patrol 은 **"지금 가장 트인 쪽"** 으로 간다(탐욕적·기억 없음). 그래서
    · 넓은 공간을 계속 맴돌아 새 영역을 체계적으로 못 넓히고
    · 같은 곳을 다시 안 지나가 **폐루프 기회가 없다** → 드리프트가 안 잡힌다
  실측: 오래 돌수록 면적은 늘지만 지도가 뭉갰다(29 m² 인데 16 m² 때보다 흐림).

  explore 는 **프런티어**(자유공간과 미탐색의 경계)로 간다.
    · 체계적 확장 — 안 본 곳이 목표다
    · 돌아가는 길에 아는 곳을 다시 지나 **폐루프가 자연히 생긴다**
    · **종료 조건이 있다** — 프런티어가 없으면 다 본 것이다

경로계획은 하지 않는다 (Nav2 미구축)
  목표 프런티어 **방위로 향하고** 기존 반응형 회피로 다가간다. 최적은 아니지만
  "어디로 갈지"에 목적이 생기는 것만으로 커버리지와 폐루프가 크게 달라진다.

🔴 매핑 품질을 위한 장치
  · 회전 중에는 전진하지 않는다 — 라이다 1스캔이 86ms 라 회전하며 달리면
    스캔이 휜다(0.3 rad/s 에서도 스캔당 1.5°)
  · 목표 도달·전환 시 **잠깐 정지**해 깨끗한 스캔을 남긴다. slam_toolbox 의
    노드가 그 자세에서 만들어져야 정합이 안정적이다
"""
import math
import sys
import time

import numpy as np
import rclpy
from geometry_msgs.msg import Twist
from nav_msgs.msg import OccupancyGrid
from rclpy.node import Node
from rclpy.qos import (QoSProfile, ReliabilityPolicy, DurabilityPolicy,
                       HistoryPolicy, qos_profile_sensor_data)
from sensor_msgs.msg import LaserScan
from tf2_ros import Buffer, TransformListener

CLEAR_M = 0.55           # 전방이 이보다 가까우면 못 간다
CONE_DEG = 40.0
CTRL_HZ = 10.0
REACH_M = 0.45           # 목표에 이만큼 다가가면 도달로 본다
REPLAN_S = 6.0           # 이 주기로 프런티어를 다시 고른다
SETTLE_S = 0.6           # 전환 시 정지 시간 (깨끗한 스캔 확보)
ALIGN_RAD = 0.30         # 이 안으로 정렬되면 전진 시작 (약 17°)
MIN_FRONTIER_CELLS = 6   # 이보다 작은 프런티어 덩어리는 잡음으로 본다
STUCK_S = 12.0           # 목표에 다가가지 못한 채 이 시간이 지나면 목표 폐기


class Explorer(Node):
    def __init__(self):
        super().__init__("explorer")
        self.map = None
        self.scan = None
        self.create_subscription(
            OccupancyGrid, "/map", self._map,
            QoSProfile(reliability=ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL,
                       history=HistoryPolicy.KEEP_LAST, depth=1))
        self.create_subscription(LaserScan, "/scan", self._scan,
                                 qos_profile_sensor_data)
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.tf_buf = Buffer()
        self.tf_listener = TransformListener(self.tf_buf, self)
        self.banned = []          # 도달 실패한 목표들 (x, y)

    def _map(self, m):
        self.map = m

    def _scan(self, m):
        self.scan = m

    def pose(self):
        """map 프레임에서의 (x, y, yaw). 못 얻으면 None."""
        try:
            t = self.tf_buf.lookup_transform("map", "base_link", rclpy.time.Time())
        except Exception:
            return None
        q = t.transform.rotation
        return (t.transform.translation.x, t.transform.translation.y,
                math.atan2(2 * (q.w * q.z), 1 - 2 * (q.z * q.z)))

    # ── 프런티어 ────────────────────────────────────────────────
    def frontiers(self):
        """자유공간이면서 미탐색과 맞닿은 셀들을 덩어리로 묶어 (x, y, 크기) 반환."""
        m = self.map
        if m is None:
            return []
        w, h, res = m.info.width, m.info.height, m.info.resolution
        ox, oy = m.info.origin.position.x, m.info.origin.position.y
        g = np.asarray(m.data, dtype=np.int16).reshape(h, w)

        free = (g >= 0) & (g <= 50)
        unknown = g < 0
        # 미탐색과 4-이웃으로 맞닿은 자유 셀
        nb = np.zeros_like(unknown)
        nb[1:, :] |= unknown[:-1, :]
        nb[:-1, :] |= unknown[1:, :]
        nb[:, 1:] |= unknown[:, :-1]
        nb[:, :-1] |= unknown[:, 1:]
        front = free & nb
        if not front.any():
            return []

        # 라벨링 없이 격자 다운샘플로 덩어리화 — scipy 없이 가볍게 간다.
        # 정확한 연결성분이 필요하진 않고, "대략 어디에 얼마나" 면 충분하다.
        ys, xs = np.nonzero(front)
        cell = max(2, int(round(0.30 / res)))       # 30cm 격자
        keys = (ys // cell) * 10000 + (xs // cell)
        out = []
        for k in np.unique(keys):
            sel = keys == k
            n = int(sel.sum())
            if n < MIN_FRONTIER_CELLS:
                continue
            cx = ox + (xs[sel].mean() + 0.5) * res
            cy = oy + (ys[sel].mean() + 0.5) * res
            out.append((cx, cy, n))
        return out

    def pick(self, px, py):
        """가까우면서 큰 프런티어. 거리에 더 큰 가중을 준다 — 멀리 가면
        가는 길에 새 프런티어가 생겨 어차피 계획이 바뀐다."""
        best, best_score = None, -1e9
        for fx, fy, n in self.frontiers():
            if any(math.hypot(fx - bx, fy - by) < 0.5 for bx, by in self.banned):
                continue
            d = math.hypot(fx - px, fy - py)
            if d < 0.35:                 # 이미 그 자리다
                continue
            score = n * 0.6 - d * 12.0
            if score > best_score:
                best, best_score = (fx, fy), score
        return best

    # ── 라이다 ──────────────────────────────────────────────────
    def cone_min(self, half=CONE_DEG):
        m = self.scan
        if m is None:
            return float("inf")
        n = len(m.ranges)
        a = m.angle_min + np.arange(n) * m.angle_increment
        r = np.asarray(m.ranges, dtype=float)
        ok = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
        a, r = a[ok], r[ok]
        if len(r) == 0:
            return float("inf")
        d = np.arctan2(np.sin(a), np.cos(a))
        sel = np.abs(d) <= math.radians(half)
        return float(r[sel].min()) if sel.any() else float("inf")

    def cmd(self, vx, wz):
        t = Twist()
        t.linear.x, t.angular.z = vx, wz
        self.pub.publish(t)

    def halt(self, secs=0.0):
        for _ in range(6):
            try:
                self.cmd(0.0, 0.0)
            except Exception:
                return
            time.sleep(0.05)
        if secs:
            time.sleep(secs)


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 240.0
    vx = float(sys.argv[2]) if len(sys.argv) > 2 else 0.11
    wz = float(sys.argv[3]) if len(sys.argv) > 3 else 0.30

    rclpy.init()
    node = Explorer()
    t0 = time.time()
    while (node.map is None or node.scan is None) and time.time() - t0 < 12:
        rclpy.spin_once(node, timeout_sec=0.1)
    if node.map is None:
        print("지도 없음 — slam_toolbox 확인")
        return 1
    # 🔴 TF 버퍼는 구독 후 채워지는 데 시간이 걸린다. 지도·스캔이 먼저 와도
    #    TF 는 아직 비어 있을 수 있으므로 **기다려 준다.** 한 번만 보고 포기하면
    #    멀쩡한 상태에서도 기동에 실패한다(실제로 그랬다).
    t_tf = time.time()
    while node.pose() is None and time.time() - t_tf < 15:
        rclpy.spin_once(node, timeout_sec=0.1)
    if node.pose() is None:
        print("map→base_link TF 를 15초 기다려도 못 얻었다 — slam_toolbox 확인")
        return 1

    target = None
    t_target = t_progress = 0.0
    best_d = 1e9
    n_reach = n_drop = n_replan = 0
    t0 = time.time()
    try:
        while time.time() - t0 < secs:
            rclpy.spin_once(node, timeout_sec=0.02)
            p = node.pose()
            if p is None:
                node.cmd(0.0, 0.0)
                continue
            px, py, yaw = p
            now = time.time()

            # 목표 선정·갱신
            if target is None or now - t_target > REPLAN_S:
                nt = node.pick(px, py)
                if nt is None:
                    if target is None:
                        print(f"[{now-t0:6.1f}s] 프런티어가 없다 — 탐사 완료")
                        break
                else:
                    changed = (target != nt)
                    if changed:
                        n_replan += 1
                    target = nt
                    t_target = now
                    if changed:
                        best_d = math.hypot(target[0]-px, target[1]-py)
                        t_progress = now
                        # 🔴 목표가 **바뀔 때만** 멈춘다. 매 재계획마다 멈추면
                        #    정지 명령이 펌웨어 PID 의 적분항을 리셋하는데,
                        #    저속 제자리 회전(0.3 rad/s → duty 7.6%)은 제자리회전
                        #    데드밴드(>13%)보다 낮아 **적분이 쌓여야만 겨우 돈다.**
                        #    6초마다 리셋하면 문턱을 영원히 못 넘어 로봇이 굳는다.
                        #    (실측: 24초간 yaw 변화 0)
                        node.halt(SETTLE_S)
                        continue

            d = math.hypot(target[0]-px, target[1]-py)
            # 🔴 정체 판정은 **마지막 진전 시각** 기준이어야 한다.
            #    목표 선정 시각으로 재면 정상 접근 중에도 목표를 버린다
            #    (접근 중에는 d ≈ best_d 라 "진전 없음" 조건이 항상 참이 된다)
            if d < best_d - 0.05:
                best_d, t_progress = d, now
            if d < REACH_M:
                n_reach += 1
                print(f"[{now-t0:6.1f}s] 프런티어 도달 ({d*100:.0f}cm) — 다음 목표")
                node.halt(SETTLE_S)
                target = None
                continue
            if now - t_progress > STUCK_S:
                n_drop += 1
                print(f"[{now-t0:6.1f}s] {STUCK_S:.0f}초간 접근 실패 → 목표 폐기 "
                      f"(남은 {d:.2f}m)")
                node.banned.append(target)
                target = None
                node.halt(SETTLE_S)
                continue

            # 목표 방위로 정렬 → 전진
            bearing = math.atan2(target[1]-py, target[0]-px)
            err = math.atan2(math.sin(bearing-yaw), math.cos(bearing-yaw))
            ahead = node.cone_min()

            if abs(err) > ALIGN_RAD:
                # 🔴 회전 중에는 전진하지 않는다 — 라이다 1스캔 86ms 라
                #    회전하며 달리면 스캔이 휘어 지도가 뭉갠다
                node.cmd(0.0, wz if err > 0 else -wz)
            elif ahead < CLEAR_M:
                # 목표 방향이 막혔다 — 트인 쪽으로 살짝 비껴 간다
                node.cmd(0.0, wz if err >= 0 else -wz)
            else:
                node.cmd(vx, 0.0)
            time.sleep(1.0 / CTRL_HZ)
    except KeyboardInterrupt:
        print("\n중단")
    finally:
        node.halt()

    el = time.time() - t0
    print(f"\n  {el:.0f}초 · 프런티어 도달 {n_reach}회 · 목표 폐기 {n_drop}회 · "
          f"재계획 {n_replan}회 · 남은 프런티어 {len(node.frontiers())}개")
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
