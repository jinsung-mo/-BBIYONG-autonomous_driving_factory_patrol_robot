#!/usr/bin/env python3
"""라이다가 회전 중심(구동축 중심)에서 얼마나 벗어나 있는지 측정.

원리
  제자리 회전 중 벽까지의 **수직거리**를 계속 재면
      d_perp(t) = D + e·cos(φ(t) − α)
  D  = 회전중심에서 벽까지 거리 (상수)
  e  = 라이다의 회전중심 이탈량      ← 구하려는 값
  α  = 이탈 방향 (라이다 프레임 기준)
  φ  = 그때의 벽 법선 방위 (같이 측정된다)

  즉 "수직거리 vs 벽법선방위"에 코사인을 맞추면 진폭이 e다.
  라이다가 정확히 중심에 있으면 e=0이고 거리가 전혀 안 흔들린다.

  이 값은 base_link → laser_frame 의 병진(x,y)이 되고,
  동시에 §K가 윤거를 잴 때 쓴 "제자리 회전 = 순수 회전" 가정의 검증이다.

    python3 lidar_offset.py [회전초] [바퀴속도]
"""
import math
import sys
import time

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan

sys.path.insert(0, "/home/e101/calib")
from bench import Bot                      # noqa: E402
from wall_measure import ransac_line       # noqa: E402

SECTOR_DEG = 55.0
MIN_POINTS = 30


class Spin(Node):
    def __init__(self):
        super().__init__("lidar_offset")
        self.last = None
        self.rng = np.random.default_rng(42)
        self.create_subscription(LaserScan, "/scan", self._cb, qos_profile_sensor_data)

    def _cb(self, msg):
        self.last = msg

    def wall(self, msg):
        n = len(msg.ranges)
        a = msg.angle_min + np.arange(n) * msg.angle_increment
        r = np.asarray(msg.ranges, dtype=float)
        ok = np.isfinite(r) & (r > msg.range_min) & (r < msg.range_max)
        a, r = a[ok], r[ok]
        if len(r) < MIN_POINTS:
            return None
        th0 = a[int(np.argmin(r))]
        d = np.arctan2(np.sin(a - th0), np.cos(a - th0))
        sel = np.abs(d) <= math.radians(SECTOR_DEG)
        if sel.sum() < MIN_POINTS:
            return None
        x, y = r[sel] * np.cos(a[sel]), r[sel] * np.sin(a[sel])
        keep = ransac_line(x, y, self.rng)
        if keep is None or keep.sum() < MIN_POINTS:
            return None
        cx, cy = x[keep].mean(), y[keep].mean()
        _u, _s, vt = np.linalg.svd(
            np.column_stack([x[keep] - cx, y[keep] - cy]), full_matrices=False)
        nx, ny = vt[1]
        if nx * cx + ny * cy < 0:
            nx, ny = -nx, -ny
        res = np.abs((x[keep] - cx) * nx + (y[keep] - cy) * ny)
        return abs(nx * cx + ny * cy), math.atan2(ny, nx), float(res.std())


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 14.0
    ws = float(sys.argv[2]) if len(sys.argv) > 2 else 0.08

    rclpy.init()
    node = Spin()
    t0 = time.time()
    while node.last is None and time.time() - t0 < 3.0:
        rclpy.spin_once(node, timeout_sec=0.05)
    if node.last is None:
        print("라이다 없음")
        return 1

    bot = Bot()
    time.sleep(0.5)
    bot.reset_counts()
    time.sleep(0.3)
    samples, lc, rc = [], 0, 0
    t0 = time.time()
    try:
        while time.time() - t0 < secs:
            bot.send(f"v {ws:.4f} {-ws:.4f}")      # 제자리 회전
            rclpy.spin_once(node, timeout_sec=0.05)
            rows = bot.read_telemetry(0.05)
            if rows:
                lc, rc = rows[-1][8], rows[-1][9]
            w = node.wall(node.last) if node.last is not None else None
            if w and w[2] < 0.006:                 # 잔차 6mm 미만만 채택
                samples.append((w[0], w[1], lc, rc))
    finally:
        bot.stop()
        time.sleep(0.3)
        bot.close()
    node.destroy_node()
    rclpy.shutdown()

    if len(samples) < 20:
        print(f"표본 부족 ({len(samples)}개) — 벽이 계속 보이는 자리에서 재시도")
        return 1

    d = np.array([s[0] for s in samples])
    phi = np.array([s[1] for s in samples])
    span = np.degrees(np.ptp(np.unwrap(phi)))
    print(f"표본 {len(samples)}개 · 법선 방위 변화폭 {span:.0f}°")
    if span < 90:
        print(f"⚠️ 회전이 부족하다({span:.0f}°). 코사인 위상을 못 가른다 — "
              f"회전 시간을 늘려 재측정.")

    # d = D + e·cos(phi − α)  →  선형 최소제곱 [1, cos φ, sin φ]
    A = np.column_stack([np.ones_like(phi), np.cos(phi), np.sin(phi)])
    coef, *_ = np.linalg.lstsq(A, d, rcond=None)
    D, c, s = coef
    e = math.hypot(c, s)
    alpha = math.atan2(s, c)
    pred = A @ coef
    rms = float(np.sqrt(np.mean((d - pred) ** 2)))

    # 🔴 부호 주의: 라이다에서 벽까지 거리는 d = D − p·n̂ 이다.
    #    적합식 D + e·cos(φ−α) 와 맞추면 −|p|cos(φ−θp) = e·cos(φ−α) 이므로
    #    이탈 방향 θp 는 α 가 아니라 **α − 180°** 다. (한 번 틀렸던 곳)
    theta_p = alpha - math.pi
    px, py = e * math.cos(theta_p), e * math.sin(theta_p)

    print(f"\n  회전중심→벽 거리 D  {D*1000:8.1f} mm")
    print(f"  라이다 이탈량   e   {e*1000:8.1f} mm   ← base_link→laser 병진 크기")
    print(f"  이탈 방향       θp  {math.degrees(theta_p):8.1f} °  (적합 위상 α의 반대)")
    print(f"  적합 잔차 RMS       {rms*1000:8.1f} mm")
    print(f"\n  → base_link(구동축 중심) 기준 라이다 위치")
    print(f"     x={px*1000:+.1f} mm, y={py*1000:+.1f} mm   "
          f"({'앞' if px > 0 else '뒤'}쪽)")
    if e * 1000 < 10:
        print("  ✅ 10mm 미만 — 사실상 회전중심. §K의 '순수 회전' 가정이 성립한다")
    else:
        print(f"  ⚠️ {e*1000:.0f}mm — TF에 반드시 넣어야 한다. "
              f"안 넣으면 제자리 회전 시 SLAM이 스캔을 못 맞춘다")

    # ── 덤: 같은 데이터로 윤거를 독립 측정한다 ────────────────────────────
    # 벽 법선의 **방위각**은 라이다의 병진에 오염되지 않는다 — 평면의 법선
    # 방향은 관측점을 옮겨도 그대로이고, 로봇이 회전한 만큼만 돌아간다.
    # 따라서 법선 누적 회전 = 참 회전량이고, 같은 구간 엔코더 카운트 차와
    # 나누면 윤거가 나온다. §K의 스캔 상호상관보다 가정이 하나 적다
    # (§K는 "제자리 회전 = 순수 원형 시프트"를 전제하는데 e=59mm면 깨진다).
    lcs = np.array([s[2] for s in samples], dtype=float)
    rcs = np.array([s[3] for s in samples], dtype=float)
    yaw = np.unwrap(phi)
    dyaw = yaw[-1] - yaw[0]
    dl = (lcs[-1] - lcs[0]) * 0.16348 / 1000.0     # m
    dr = (rcs[-1] - rcs[0]) * 0.16348 / 1000.0
    if abs(dyaw) > math.radians(180):
        track = (dl - dr) / dyaw
        print(f"\n  [독립 윤거 측정]")
        print(f"    법선 누적 회전 {math.degrees(dyaw):+.1f}° · "
              f"좌 {dl*1000:+.0f}mm · 우 {dr*1000:+.0f}mm")
        print(f"    윤거 = (좌−우)/회전 = {abs(track)*1000:.1f} mm"
              f"   (§K 실측 201.8mm 대비 {abs(track)*1000/201.8*100-100:+.1f}%)")
    else:
        print(f"\n  [독립 윤거 측정] 회전 {math.degrees(abs(dyaw)):.0f}° — "
              f"180° 미만이라 생략")
    return 0


if __name__ == "__main__":
    sys.exit(main())
