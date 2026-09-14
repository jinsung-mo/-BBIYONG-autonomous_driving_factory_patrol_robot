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
MIN_GOAL_M = REACH_M + 0.15  # 고르자마자 도달 처리되는 근거리 frontier 제외
OBSTACLE_MIN_BEAMS = 3    # 단일 노이즈 점이 아니라 연속된 LiDAR 빔으로 장애물 확인
ESCAPE_S = 3.0            # 막혔을 때 열린 LiDAR 방향으로 이동을 시도하는 시간
ESCAPE_SIDE_DEG = 60.0    # 좌우 여유 공간을 비교할 중심 각도
ESCAPE_HALF_DEG = 25.0
CORRIDOR_HALF_WIDTH_M = 0.22  # frontier까지 직선 접근할 때 필요한 반폭
TARGET_CONTEXT_M = 0.75       # frontier 주변의 미탐색/장애물 밀도 평가 반경
OCCUPIED_THRESHOLD = 65
SETTLE_S = 0.6           # 전환 시 정지 시간 (깨끗한 스캔 확보)
TURN_IN_PLACE_RAD = 0.70  # 큰 오차만 제자리 회전 (약 40°)
MOVING_TURN_MAX = 0.15    # 전진 중 mapping을 흐리지 않을 완만한 각속도 상한
STEER_KP = 1.2
MIN_FORWARD_SCALE = 0.35
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
        self.escape_until = 0.0
        self.escape_turn = 1.0
        self.laser_yaw = None

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

    def pick(self, px, py, yaw):
        """열리고 미탐색 영역이 넓은 frontier를 우선하고 혼잡한 경로는 피한다."""
        m = self.map
        w, h, res = m.info.width, m.info.height, m.info.resolution
        ox, oy = m.info.origin.position.x, m.info.origin.position.y
        g = np.asarray(m.data, dtype=np.int16).reshape(h, w)
        corridor_cells = max(1, int(math.ceil(CORRIDOR_HALF_WIDTH_M / res)))
        context_cells = max(1, int(math.ceil(TARGET_CONTEXT_M / res)))

        best, best_score = None, -1e9
        best_detail = None
        for fx, fy, n in self.frontiers():
            if any(math.hypot(fx - bx, fy - by) < 0.5 for bx, by in self.banned):
                continue
            d = math.hypot(fx - px, fy - py)
            if d < MIN_GOAL_M:
                continue

            # 목표의 REACH_M 앞까지만 검사한다. frontier 자체는 unknown 경계라
            # 마지막 구간까지 free cell을 요구하면 모든 정상 후보가 탈락한다.
            approach_d = max(0.0, d - REACH_M)
            samples = max(2, int(math.ceil(approach_d / res)))
            blocked = False
            for step in range(samples + 1):
                ratio = step / samples
                sx = px + (fx - px) * ratio * (approach_d / d)
                sy = py + (fy - py) * ratio * (approach_d / d)
                gx = int((sx - ox) / res)
                gy = int((sy - oy) / res)
                x0, x1 = max(0, gx - corridor_cells), min(w, gx + corridor_cells + 1)
                y0, y1 = max(0, gy - corridor_cells), min(h, gy + corridor_cells + 1)
                patch = g[y0:y1, x0:x1]
                # 한 개짜리 map speckle에는 과민하지 않되, 실제 장애물 덩어리가
                # 있는 직선 경로는 후보에서 제외한다.
                if patch.size == 0 or np.count_nonzero(
                    patch > OCCUPIED_THRESHOLD
                ) >= 3:
                    blocked = True
                    break
            if blocked:
                continue

            gx = int((fx - ox) / res)
            gy = int((fy - oy) / res)
            x0, x1 = max(0, gx - context_cells), min(w, gx + context_cells + 1)
            y0, y1 = max(0, gy - context_cells), min(h, gy + context_cells + 1)
            context = g[y0:y1, x0:x1]
            if context.size == 0:
                continue
            unknown_ratio = float(np.count_nonzero(context < 0) / context.size)
            obstacle_ratio = float(
                np.count_nonzero(context > OCCUPIED_THRESHOLD) / context.size
            )

            bearing = math.atan2(fy - py, fx - px)
            relative_deg = math.degrees(
                math.atan2(math.sin(bearing - yaw), math.cos(bearing - yaw))
            )
            lidar_clearance = min(
                8.0, self.sector_clearance(relative_deg, half_deg=15.0)
            )

            # 가까운 후보만 반복 선택하던 기존 -12*d를 크게 완화한다.
            # 열린 LiDAR 방향과 넓은 unknown 영역은 보상하고, 주변 점유 셀은
            # 강하게 감점한다.
            score = (
                n * 0.6
                + lidar_clearance * 4.0
                + unknown_ratio * 20.0
                - obstacle_ratio * 80.0
                - d * 2.0
            )
            if score > best_score:
                best, best_score = (fx, fy), score
                best_detail = (d, lidar_clearance, unknown_ratio, obstacle_ratio)
        if best_detail is not None:
            d, clear, unknown, obstacle = best_detail
            self.get_logger().info(
                "frontier selected: "
                f"distance={d:.2f}m lidar_clear={clear:.2f}m "
                f"unknown={unknown:.0%} occupied={obstacle:.1%} "
                f"score={best_score:.1f}"
            )
        return best

    # ── 라이다 ──────────────────────────────────────────────────
    def scan_angles_in_base(self, m):
        """LaserScan 각도를 센서 프레임에서 base_link 기준 각도로 변환한다."""
        if self.laser_yaw is None:
            try:
                t = self.tf_buf.lookup_transform(
                    "base_link", m.header.frame_id, rclpy.time.Time()
                )
            except Exception:
                return None
            q = t.transform.rotation
            self.laser_yaw = math.atan2(
                2 * (q.w * q.z), 1 - 2 * (q.z * q.z)
            )
            self.get_logger().info(
                f"LiDAR yaw in base_link: {math.degrees(self.laser_yaw):+.2f} deg"
            )
        sensor_angles = m.angle_min + np.arange(len(m.ranges)) * m.angle_increment
        return np.arctan2(
            np.sin(sensor_angles + self.laser_yaw),
            np.cos(sensor_angles + self.laser_yaw),
        )

    def blocked_ahead(self, half=CONE_DEG):
        """전방 원뿔에서 연속된 여러 LiDAR 빔이 가까울 때만 막힘으로 판단한다."""
        m = self.scan
        if m is None:
            return True
        a = self.scan_angles_in_base(m)
        if a is None:
            return True
        r = np.asarray(m.ranges, dtype=float)
        valid = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
        in_cone = np.abs(a) <= math.radians(half)
        near = valid & in_cone & (r < CLEAR_M)
        supported = np.convolve(
            near.astype(np.uint8),
            np.ones(OBSTACLE_MIN_BEAMS, dtype=np.uint8),
            mode="same",
        )
        return bool(np.any(supported >= OBSTACLE_MIN_BEAMS))

    def sector_clearance(self, center_deg, half_deg=ESCAPE_HALF_DEG):
        """LiDAR 구간의 보수적인 여유 거리. no-return(+inf)는 range_max로 본다."""
        m = self.scan
        if m is None:
            return 0.0
        r = np.asarray(m.ranges, dtype=float)
        a = self.scan_angles_in_base(m)
        if a is None:
            return 0.0
        center = math.radians(center_deg)
        delta = np.arctan2(np.sin(a - center), np.cos(a - center))
        in_sector = np.abs(delta) <= math.radians(half_deg)
        usable = (
            (np.isfinite(r) & (r > m.range_min) & (r < m.range_max))
            | np.isposinf(r)
        )
        selected = np.where(np.isposinf(r), m.range_max, r)[in_sector & usable]
        if selected.size == 0:
            return 0.0
        # 한두 개의 먼 빔보다 구간 전체가 실제로 열린 방향을 선호한다.
        return float(np.percentile(selected, 25))

    def choose_escape_turn(self):
        """더 넓게 열린 LiDAR 쪽으로 회전 방향(+좌/-우)을 고른다."""
        left = self.sector_clearance(ESCAPE_SIDE_DEG)
        right = self.sector_clearance(-ESCAPE_SIDE_DEG)
        return (1.0 if left >= right else -1.0), left, right

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
    t_progress = 0.0
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

            # 목표 정렬과 장애물 회피가 서로 반대 회전을 반복하지 않게, 막힌
            # 뒤에는 잠시 frontier를 무시하고 LiDAR로 확인한 열린 쪽에 전진한다.
            # 회전만으로는 새 공간이 보이지 않으므로, 전방이 열린 뒤 실제로
            # 이동하는 것이 이 상태의 목적이다.
            if now < node.escape_until:
                if node.blocked_ahead():
                    node.cmd(0.0, node.escape_turn * wz)
                else:
                    node.cmd(vx, 0.0)
                time.sleep(1.0 / CTRL_HZ)
                continue
            if node.escape_until > 0.0:
                node.escape_until = 0.0
                target = None
                node.halt(SETTLE_S)
                continue

            # 목표를 정하면 도달·막힘·정체 중 하나가 생길 때까지 유지한다.
            # 지도 갱신 때마다 가까운 frontier로 갈아타면 정지/역회전이 반복돼
            # 짧은 지그재그만 만들고 실제 미탐색 공간으로 진입하지 못한다.
            if target is None:
                nt = node.pick(px, py, yaw)
                if nt is None:
                    print(f"[{now-t0:6.1f}s] 프런티어가 없다 — 탐사 완료")
                    break
                else:
                    target = nt
                    n_replan += 1
                    best_d = math.hypot(target[0]-px, target[1]-py)
                    t_progress = now
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

            if abs(err) > TURN_IN_PLACE_RAD:
                # 방향이 크게 다를 때만 제자리 회전한다.
                node.cmd(0.0, wz if err > 0 else -wz)
            elif node.blocked_ahead():
                # 목표 방향이 막히면 같은 목표로 되돌아가며 제자리 진동하지
                # 않고, LiDAR에서 더 열린 좌/우 방향을 골라 짧게 탈출한다.
                node.escape_turn, left, right = node.choose_escape_turn()
                node.escape_until = now + ESCAPE_S
                node.banned.append(target)
                n_drop += 1
                print(
                    f"[{now-t0:6.1f}s] 전방 막힘 → "
                    f"{'좌' if node.escape_turn > 0 else '우'}측 열린 공간으로 이동 "
                    f"(좌 {left:.2f}m / 우 {right:.2f}m)"
                )
                node.cmd(0.0, node.escape_turn * wz)
            else:
                # 작은 방위 오차마다 정지-회전을 반복하지 않고 완만한 원호로
                # 목표를 추종한다. 전진 중 각속도는 낮게 제한해 scan 왜곡을
                # 억제하고, 오차가 클수록 선속도를 줄인다.
                moving_turn_limit = min(abs(wz), MOVING_TURN_MAX)
                steer = max(
                    -moving_turn_limit,
                    min(moving_turn_limit, STEER_KP * err),
                )
                speed_scale = max(
                    MIN_FORWARD_SCALE,
                    1.0 - abs(err) / TURN_IN_PLACE_RAD,
                )
                node.cmd(vx * speed_scale, steer)
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
