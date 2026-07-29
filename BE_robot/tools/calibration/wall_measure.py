#!/usr/bin/env python3
"""라이다를 자로 써서 차체 기준 라이다 위치를 잰다 (S0 — 라이다 장착 자세).

방법: 차체의 한 면을 벽에 밀착시킨 뒤 스캔에서 **벽면까지의 수직거리**를 구한다.
      전면 밀착 → d_front = 라이다에서 전면까지 거리
      후면 밀착 → d_rear  = 라이다에서 후면까지 거리
      d_front + d_rear = 차체 전장, 비율이 base_link 안에서 라이다의 X 오프셋.

수직거리를 쓰는 이유: 최근접 1점(r_min)은 각도 양자화·노이즈에 흔들리지만,
벽면에 직선을 맞춰 원점에서의 수직거리를 구하면 수십~수백 점이 평균된다.
(`docs/실측_데이터.md` §J가 바퀴 지름을 잴 때 쓴 것과 같은 원리다.)

    python3 wall_measure.py [스캔수] [라벨]
"""
import math
import sys

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import LaserScan

SECTOR_DEG = 55.0        # 최근접 방향 ±이 범위에서 후보를 고른다 (RANSAC이 걸러낸다)
MIN_POINTS = 30
RANSAC_ITERS = 300
INLIER_M = 0.006         # 6mm — 라이다 거리잡음(관측 RMS ~2mm)의 3배


def ransac_line(x, y, rng):
    """최다 지지를 받는 직선의 내점 마스크. 벽이 끝나는 지점 너머를 버린다."""
    n = len(x)
    if n < MIN_POINTS:
        return None
    best, best_cnt = None, 0
    for _ in range(RANSAC_ITERS):
        i, j = rng.integers(0, n, 2)
        dx, dy = x[j] - x[i], y[j] - y[i]
        L = math.hypot(dx, dy)
        if L < 0.02:                 # 2cm 미만 기저선은 방향이 잡음에 묻힌다
            continue
        nx, ny = -dy / L, dx / L     # 법선
        d = np.abs((x - x[i]) * nx + (y - y[i]) * ny)
        cnt = int((d <= INLIER_M).sum())
        if cnt > best_cnt:
            best, best_cnt = d <= INLIER_M, cnt
    return best


class WallMeasure(Node):
    def __init__(self, n_scans):
        super().__init__("wall_measure")
        self.n_scans = n_scans
        self.results = []
        self.meta = None
        self.rng = np.random.default_rng(42)   # 재현 가능하게 고정
        # 라이다 드라이버는 BEST_EFFORT로 낸다 — RELIABLE로 구독하면 아무것도 안 온다
        qos = QoSProfile(reliability=ReliabilityPolicy.BEST_EFFORT,
                         history=HistoryPolicy.KEEP_LAST, depth=10)
        self.sub = self.create_subscription(LaserScan, "/scan", self.cb, qos)

    def cb(self, msg):
        if len(self.results) >= self.n_scans:
            return
        n = len(msg.ranges)
        ang = msg.angle_min + np.arange(n) * msg.angle_increment
        rng = np.asarray(msg.ranges, dtype=float)

        ok = np.isfinite(rng) & (rng > msg.range_min) & (rng < msg.range_max)
        if ok.sum() < MIN_POINTS:
            return
        if self.meta is None:
            self.meta = dict(n=n, amin=msg.angle_min, amax=msg.angle_max,
                             ainc=msg.angle_increment, rmin=msg.range_min,
                             rmax=msg.range_max, frame=msg.header.frame_id)

        a, r = ang[ok], rng[ok]
        i_min = int(np.argmin(r))
        th0, r0 = a[i_min], r[i_min]

        # 최근접 방향 주변만 = 벽면
        half = math.radians(SECTOR_DEG)
        d = np.arctan2(np.sin(a - th0), np.cos(a - th0))   # 각도 차 정규화
        sel = np.abs(d) <= half
        if sel.sum() < MIN_POINTS:
            return
        x, y = r[sel] * np.cos(a[sel]), r[sel] * np.sin(a[sel])

        # 🔴 RANSAC이 필수다. 벽은 어딘가에서 끝난다(문틀·모서리·가구).
        #    각도 구간으로만 자르면 벽 너머 점이 섞이는데, 최소제곱은 이상치에
        #    약해서 그 몇 점이 법선을 수십 도 끌어당긴다 (관측: 법선 30° 이탈).
        #    "일단 전체로 맞추고 3σ로 깎기"는 안 통한다 — 시작 적합이 이미
        #    틀어져 있으면 잔차가 전부 커서 아무것도 안 걸러진다.
        #    무작위 2점으로 후보를 세워 최다 지지를 고르는 방식만 이 함정을 피한다.
        keep = ransac_line(x, y, self.rng)
        if keep is None or keep.sum() < MIN_POINTS:
            return
        cx, cy = x[keep].mean(), y[keep].mean()
        _u, _s, vt = np.linalg.svd(
            np.column_stack([x[keep] - cx, y[keep] - cy]), full_matrices=False)
        nx, ny = vt[1]                       # 최소 분산 방향 = 법선
        d_perp = abs(nx * cx + ny * cy)      # 원점→직선 수직거리
        resid = np.abs((x[keep] - cx) * nx + (y[keep] - cy) * ny)
        sel_n = int(keep.sum())
        phi = math.atan2(ny, nx)
        if d_perp > 0:                       # 법선을 원점 바깥 방향으로 통일
            if (nx * cx + ny * cy) < 0:
                phi = math.atan2(-ny, -nx)

        self.results.append(dict(d_perp=d_perp, phi=phi, r_min=r0, th_min=th0,
                                 npts=sel_n, ndrop=int(sel.sum()) - sel_n,
                                 rms=float(resid.std()), flat=float(resid.max())))


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    label = sys.argv[2] if len(sys.argv) > 2 else "측정"

    rclpy.init()
    node = WallMeasure(n)
    for _ in range(int(n * 40)):
        rclpy.spin_once(node, timeout_sec=0.1)
        if len(node.results) >= n:
            break
    node.destroy_node()
    rclpy.shutdown()

    if not node.results:
        print("실패: /scan 에서 유효한 스캔을 받지 못했다.")
        return 1

    R = node.results
    dp = np.array([r["d_perp"] for r in R]) * 1000.0        # mm
    rm = np.array([r["r_min"] for r in R]) * 1000.0
    ph = np.degrees([r["phi"] for r in R])
    th = np.degrees([r["th_min"] for r in R])
    rms = np.array([r["rms"] for r in R]) * 1000.0

    m = node.meta
    print(f"=== {label} ===")
    print(f"스캔 {len(R)}개 · frame_id='{m['frame']}' · 점 {m['n']}개/스캔 · "
          f"각도 {math.degrees(m['amin']):.1f}~{math.degrees(m['amax']):.1f}° · "
          f"사거리 {m['rmin']:.3f}~{m['rmax']:.1f}m")
    print()
    print(f"  벽면 수직거리   {dp.mean():8.1f} mm   (std {dp.std():.1f}, "
          f"min {dp.min():.1f}, max {dp.max():.1f})   ← 이 값을 쓴다")
    print(f"  최근접 1점      {rm.mean():8.1f} mm   (std {rm.std():.1f})")
    print(f"  벽 법선 방위    {ph.mean():8.2f} °    (std {ph.std():.2f})")
    print(f"  최근접 방위     {th.mean():8.2f} °    (std {th.std():.2f})")
    print(f"  적합 점수       {R[0]['npts']}점 (이상치 {R[0]['ndrop']}점 제외) · "
          f"잔차 RMS {rms.mean():.2f} mm · 최대 "
          f"{np.mean([r['flat'] for r in R])*1000:.1f} mm")
    print()
    print(f"  RESULT {label} d_perp_mm={dp.mean():.1f} std={dp.std():.2f} "
          f"normal_deg={ph.mean():.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
