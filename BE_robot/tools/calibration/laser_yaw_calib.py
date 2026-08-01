#!/usr/bin/env python3
"""laser_frame 의 요(yaw) 장착 오차 측정 — 평면 2개 + 직진.

    python3 laser_yaw_calib.py [이동거리 m] [속도 m/s]

원리
  로봇을 앞으로만 밀면(각속도 0) 라이다는 로봇의 전진축 방향으로 병진한다.
  법선이 서로 다른 평면 A·B 를 동시에 보고 있으면, 각 평면까지의 수직거리
  변화가 이동벡터의 그 법선 성분이다:

      Δd_i = −( t · n̂_i ) = −( tx·cos φ_i + ty·sin φ_i )

  두 식 → (tx, ty) 유일 해. 이동 방향 β = atan2(ty, tx) 가 곧
  "라이다 프레임에서 본 로봇 전진축"이고, TF 파라미터는 그 반대부호다:

      laser_yaw = −β

  ⚠️ 벽 하나만 쓰면 |β| 만 나오고 부호가 안 갈린다. 그래서 두 개가 필요하다.

전제
  · 서로 다른 방향의 평면이 2개 이상 보이는 자리 (방 모서리 근처가 좋다)
  · esp32_base_node 가 떠 있을 것 (/cmd_vel, /odom 사용)
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

MIN_POINTS = 40
MAX_PLANES = 3
MIN_NORMAL_SEP_DEG = 25.0     # 두 평면이 이보다 벌어져야 연립이 잘 풀린다


def find_planes(a, r, rng, n_planes=MAX_PLANES):
    """스캔에서 평면을 여러 개 뽑는다. 찾은 평면의 내점을 빼고 다시 찾는다."""
    x, y = r * np.cos(a), r * np.sin(a)
    alive = np.ones(len(x), dtype=bool)
    out = []
    for _ in range(n_planes):
        if alive.sum() < MIN_POINTS:
            break
        xi, yi = x[alive], y[alive]
        keep = ransac_line(xi, yi, rng)
        if keep is None or keep.sum() < MIN_POINTS:
            break
        cx, cy = xi[keep].mean(), yi[keep].mean()
        _u, _s, vt = np.linalg.svd(
            np.column_stack([xi[keep] - cx, yi[keep] - cy]), full_matrices=False)
        nx, ny = vt[1]
        if nx * cx + ny * cy < 0:
            nx, ny = -nx, -ny
        d = abs(nx * cx + ny * cy)
        res = np.abs((xi[keep] - cx) * nx + (yi[keep] - cy) * ny)
        out.append(dict(d=d, phi=math.atan2(ny, nx), n=int(keep.sum()),
                        rms=float(res.std())))
        idx = np.where(alive)[0][keep]
        alive[idx] = False
    return out


class Calib(Node):
    def __init__(self):
        super().__init__("laser_yaw_calib")
        self.scan = None
        self.pose = None
        self.rng = np.random.default_rng(7)
        self.create_subscription(LaserScan, "/scan", self._s, qos_profile_sensor_data)
        self.create_subscription(
            Odometry, "/odom", self._o,
            QoSProfile(reliability=ReliabilityPolicy.RELIABLE, depth=10))
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)

    def _s(self, m):
        self.scan = m

    def _o(self, m):
        q = m.pose.pose.orientation
        self.pose = (m.pose.pose.position.x, m.pose.pose.position.y,
                     math.atan2(2 * q.w * q.z, 1 - 2 * q.z * q.z))

    def planes(self, n_avg=8):
        """여러 스캔에서 평면을 뽑아 평균 — 단발 잡음을 줄인다."""
        acc = []
        for _ in range(n_avg * 4):
            rclpy.spin_once(self, timeout_sec=0.05)
            m = self.scan
            if m is None:
                continue
            k = len(m.ranges)
            a = m.angle_min + np.arange(k) * m.angle_increment
            r = np.asarray(m.ranges, dtype=float)
            ok = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
            pl = find_planes(a[ok], r[ok], self.rng)
            pl = [p for p in pl if p["rms"] < 0.008]
            if pl:
                acc.append(pl)
            if len(acc) >= n_avg:
                break
        return acc

    def drive(self, vx):
        t = Twist()
        t.linear.x = vx
        self.pub.publish(t)

    def halt(self):
        # 🔴 컨텍스트가 이미 죽었어도(외부 timeout·SIGTERM) 예외로 터지지 않게 한다.
        #    정지 경로에서 예외가 나면 로봇이 굴러가는 채로 스크립트만 죽는다.
        #    최종 방어선은 펌웨어 데드맨 1초 + esp32_base_node 의 0.5초 타임아웃.
        for _ in range(8):
            try:
                self.drive(0.0)
            except Exception:
                return
            time.sleep(0.05)


def merge(acc, tol_deg=8.0):
    """여러 스캔의 평면들을 법선 방위로 묶어 평균낸다."""
    flat = [p for pl in acc for p in pl]
    groups = []
    for p in flat:
        for g in groups:
            if abs(math.degrees(math.atan2(
                    math.sin(p["phi"] - g[0]["phi"]),
                    math.cos(p["phi"] - g[0]["phi"])))) < tol_deg:
                g.append(p)
                break
        else:
            groups.append([p])
    out = []
    for g in groups:
        if len(g) < max(2, len(acc) // 2):
            continue
        phis = np.array([q["phi"] for q in g])
        ref = phis[0]
        rel = np.arctan2(np.sin(phis - ref), np.cos(phis - ref))
        out.append(dict(phi=ref + rel.mean(),
                        d=float(np.mean([q["d"] for q in g])),
                        n=len(g),
                        d_std=float(np.std([q["d"] for q in g]))))
    return sorted(out, key=lambda p: -p["n"])


def main():
    dist = float(sys.argv[1]) if len(sys.argv) > 1 else 0.35
    vx = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10

    rclpy.init()
    node = Calib()
    t0 = time.time()
    while (node.scan is None or node.pose is None) and time.time() - t0 < 6:
        rclpy.spin_once(node, timeout_sec=0.05)
    if node.scan is None or node.pose is None:
        print("스캔/오도메트리 없음 — esp32_base_node 확인")
        return 1

    before = merge(node.planes())
    print(f"이동 전 평면 {len(before)}개:")
    for p in before:
        print(f"   법선 {math.degrees(p['phi']):+7.2f}°  거리 {p['d']*1000:7.1f} mm "
              f"(표본 {p['n']}, 산포 {p['d_std']*1000:.1f}mm)")
    if len(before) < 2:
        print("\n평면이 2개 미만이다. 방 모서리처럼 서로 다른 방향의 벽이")
        print("동시에 보이는 자리로 옮기고 다시 실행할 것.")
        node.destroy_node(); rclpy.shutdown(); return 1

    p0 = node.pose
    # 이동 방향: dist 가 음수면 후진. 앞이 막혔을 때 쓴다.
    sgn = 1.0 if dist >= 0 else -1.0
    dist = abs(dist)
    # 🔴 상한 시간 필수. 로봇이 벽에 막히면 moved 가 영원히 목표에 못 닿아
    #    무한 루프가 되고, 외부 timeout 이 죽이면 정지 명령도 못 보낸다.
    budget = dist / max(abs(vx), 1e-3) * 3.0 + 5.0
    t_start, stalled = time.time(), 0
    last_moved = 0.0
    try:
        while True:
            rclpy.spin_once(node, timeout_sec=0.02)
            moved = math.hypot(node.pose[0] - p0[0], node.pose[1] - p0[1])
            if moved >= dist:
                break
            if time.time() - t_start > budget:
                print(f"\n⚠️ 시간 초과 — {moved*1000:.0f}mm 만 이동했다(목표 "
                      f"{dist*1000:.0f}mm). 앞이 막혔을 가능성. "
                      f"음수 거리를 주면 후진한다.")
                break
            if moved - last_moved < 0.001:
                stalled += 1
                if stalled > 60:            # 3초간 1mm 미만 = 정지 상태
                    print(f"\n⚠️ 로봇이 멈춰 있다({moved*1000:.0f}mm). 장애물 확인.")
                    break
            else:
                stalled, last_moved = 0, moved
            node.drive(sgn * abs(vx))
            time.sleep(0.05)
    finally:
        node.halt()
    time.sleep(1.0)

    p1 = node.pose
    moved = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    dyaw = math.atan2(math.sin(p1[2] - p0[2]), math.cos(p1[2] - p0[2]))
    after = merge(node.planes())
    print(f"\n이동 후 (오도메트리 {moved*1000:.1f} mm, 회전 {math.degrees(dyaw):+.2f}°):")
    for p in after:
        print(f"   법선 {math.degrees(p['phi']):+7.2f}°  거리 {p['d']*1000:7.1f} mm")

    # 이동 전후 평면 짝짓기 — 법선이 회전량만큼 돌아간 것을 감안한다
    pairs = []
    for b in before:
        exp = b["phi"] - dyaw
        best = min(after, key=lambda q: abs(math.atan2(
            math.sin(q["phi"] - exp), math.cos(q["phi"] - exp))))
        sep = abs(math.degrees(math.atan2(
            math.sin(best["phi"] - exp), math.cos(best["phi"] - exp))))
        if sep < 10.0:
            pairs.append((b, best))
    if len(pairs) < 2:
        print("\n짝지어진 평면이 2개 미만 — 이동 중 시야가 크게 바뀌었다. 재시도.")
        node.destroy_node(); rclpy.shutdown(); return 1

    # 🔴 "가장 많이 벌어진 쌍"을 고르면 안 된다. 176° 벌어진 쌍은 서로
    #    **마주보는 평행 벽**이고, 그 두 법선은 방향이 같은 직선 위에 있어
    #    연립이 특이해진다(직교 성분 정보가 0). 실제로 그 쌍을 고른 회차에서
    #    답이 −1.27°까지 튀었다.
    #    조건수를 지배하는 건 |sin(Δφ)| 이고 이는 **90°에서 최대**다.
    best_pair, best_q, best_sep = None, -1, 0.0
    for i in range(len(pairs)):
        for j in range(i + 1, len(pairs)):
            dphi = math.atan2(
                math.sin(pairs[i][0]["phi"] - pairs[j][0]["phi"]),
                math.cos(pairs[i][0]["phi"] - pairs[j][0]["phi"]))
            q = abs(math.sin(dphi))            # 직교에 가까울수록 1
            if q > best_q:
                best_pair, best_q = (pairs[i], pairs[j]), q
                best_sep = abs(math.degrees(dphi))
    print(f"\n선택된 두 평면: 법선 간격 {best_sep:.1f}° "
          f"· 직교도 |sin Δφ| = {best_q:.3f} (1.0 이 최적)")
    if best_q < 0.42:                          # 25° 또는 155° 이내 = 나쁨
        print(f"⚠️ 직교도가 낮다 — 두 벽이 거의 평행하다. "
              f"연립이 불안정하니 모서리 쪽에서 재측정할 것")

    A, B = best_pair
    M, rhs = [], []
    for b, a_ in (A, B):
        M.append([math.cos(b["phi"]), math.sin(b["phi"])])
        rhs.append(-(a_["d"] - b["d"]))
    t_vec = np.linalg.solve(np.array(M), np.array(rhs))
    tmag = float(np.hypot(*t_vec))
    beta = math.atan2(t_vec[1], t_vec[0])
    if sgn < 0:                    # 후진했으면 이동벡터는 전진축의 반대다
        beta = math.atan2(math.sin(beta + math.pi), math.cos(beta + math.pi))
        print("  (후진 측정 — 이동벡터를 180° 뒤집어 전진축으로 환산)")

    print(f"\n  이동벡터(라이다 프레임)  tx={t_vec[0]*1000:+.1f} ty={t_vec[1]*1000:+.1f} mm")
    print(f"  크기 {tmag*1000:.1f} mm  vs  오도메트리 {moved*1000:.1f} mm  "
          f"(비 {tmag/max(moved,1e-6):.3f})")
    print(f"\n  전진축 방위 β = {math.degrees(beta):+.2f}°")
    print(f"  → laser_yaw = {-beta:+.5f} rad = {math.degrees(-beta):+.2f}°")
    if abs(tmag / max(moved, 1e-6) - 1.0) > 0.15:
        print("  ⚠️ 두 거리가 15% 이상 어긋난다 — 평면 짝짓기나 곡선주행 의심. 재측정 권장")
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
