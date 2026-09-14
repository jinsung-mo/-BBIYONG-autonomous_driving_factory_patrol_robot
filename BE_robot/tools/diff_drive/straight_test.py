#!/usr/bin/env python3
"""직진(또는 후진) 시험 — 부하 좌우격차 + 실이동거리 + 전진축 각도를 한 번에 잰다.

    python3 straight_test.py <속도 m/s> <목표거리 m>
        속도 음수 = 후진.   예) python3 straight_test.py -0.12 0.30

무엇을 재는가
  1. **부하 좌우 격차** — §L의 "바닥에 내리면 우측이 죽는다"를 PID가 잡는지
  2. **엔코더 vs 라이다 거리** — 엔코더 환산(0.16348 mm/카운트)의 실부하 검증
  3. **전진축 각도** — 라이다가 본 이동거리 / 엔코더 거리 = cos(주행방향 − 벽법선)
  4. **직진성** — 주행 중 벽 법선이 돌아가면 곡선주행이다

안전
  · 진행 방향 ±50° 부채꼴의 최소거리를 감시해 STOP_M 이하면 즉시 정지
  · 목표거리 도달 시 정지 / 타임아웃 정지 / 예외 시 finally 정지
  · 펌웨어 데드맨(1초)이 최종 방어선
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

MM_PER_COUNT = 0.16348
STOP_M = 0.22            # 진행 방향에 이보다 가까우면 정지
CONE_DEG = 50.0
SECTOR_DEG = 55.0
MIN_POINTS = 30


class Scan(Node):
    def __init__(self):
        super().__init__("straight_test_scan")
        self.last = None
        self.rng = np.random.default_rng(42)
        self.create_subscription(LaserScan, "/scan", self._cb, qos_profile_sensor_data)

    def _cb(self, msg):
        self.last = msg

    def fresh(self, timeout=3.0):
        self.last = None
        t0 = time.time()
        while self.last is None and time.time() - t0 < timeout:
            rclpy.spin_once(self, timeout_sec=0.05)
        return self.last

    def xy(self, msg):
        n = len(msg.ranges)
        a = msg.angle_min + np.arange(n) * msg.angle_increment
        r = np.asarray(msg.ranges, dtype=float)
        ok = np.isfinite(r) & (r > msg.range_min) & (r < msg.range_max)
        return a[ok], r[ok]

    def wall(self, msg):
        """가장 가까운 평면의 (수직거리 m, 법선 rad). 못 찾으면 None."""
        a, r = self.xy(msg)
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
        return abs(nx * cx + ny * cy), math.atan2(ny, nx)

    def cone_min(self, msg, heading_rad):
        """진행 방향 부채꼴 안의 최소거리."""
        a, r = self.xy(msg)
        if len(r) == 0:
            return float("inf")
        d = np.arctan2(np.sin(a - heading_rad), np.cos(a - heading_rad))
        sel = np.abs(d) <= math.radians(CONE_DEG)
        return float(r[sel].min()) if sel.any() else float("inf")


def main():
    v = float(sys.argv[1]) if len(sys.argv) > 1 else -0.12
    dist = float(sys.argv[2]) if len(sys.argv) > 2 else 0.30

    rclpy.init()
    scan = Scan()
    m0 = scan.fresh()
    if m0 is None:
        print("라이다 스캔 없음 — 드라이버 확인")
        return 1
    w0 = scan.wall(m0)
    if w0 is None:
        print("벽 평면을 못 찾음")
        return 1
    d0, phi0 = w0
    print(f"출발  벽 수직거리 {d0*1000:.1f} mm · 법선 {math.degrees(phi0):+.2f}°")

    # 진행 방향(라이다 프레임 기준 추정): 전진이면 벽쪽(phi0), 후진이면 반대
    heading = phi0 if v > 0 else phi0 + math.pi
    print(f"진행 방향 추정 {math.degrees(heading):+.1f}° · "
          f"안전정지 {STOP_M*1000:.0f}mm · 목표 {dist*1000:.0f}mm\n")

    bot = Bot()
    time.sleep(0.5)
    bot.reset_counts()
    time.sleep(0.3)

    t0 = time.time()
    timeout = abs(dist / v) * 3.0 + 3.0
    lc = rc = 0
    reason = "목표 도달"
    try:
        while True:
            bot.send(f"v {v:.4f} {v:.4f}")
            rows = bot.read_telemetry(0.15)
            if rows:
                lc, rc = rows[-1][8], rows[-1][9]
            trav = (abs(lc) + abs(rc)) / 2.0 * MM_PER_COUNT / 1000.0
            if trav >= dist:
                break
            if time.time() - t0 > timeout:
                reason = "타임아웃"
                break
            rclpy.spin_once(scan, timeout_sec=0.01)
            if scan.last is not None:
                near = scan.cone_min(scan.last, heading)
                if near < STOP_M:
                    reason = f"안전정지 (진행방향 {near*1000:.0f}mm)"
                    break
    finally:
        bot.stop()
        time.sleep(0.8)
        bot.close()

    m1 = scan.fresh()
    w1 = scan.wall(m1) if m1 is not None else None
    d_enc = (abs(lc) + abs(rc)) / 2.0 * MM_PER_COUNT / 1000.0
    imb = (abs(lc) - abs(rc)) / max(abs(lc), abs(rc), 1) * 100.0

    print(f"종료 사유: {reason}\n")
    print(f"  엔코더  좌 {lc:+d}  우 {rc:+d}  → 평균 이동 {d_enc*1000:.1f} mm")
    print(f"  좌우 카운트 격차 {imb:+.1f} %   ← §L 부하 격차가 PID로 잡혔는지")

    if w1:
        d1, phi1 = w1
        dd = (d1 - d0) * (1 if v < 0 else -1)      # 진행 방향 기준 증가량
        rot = math.degrees(math.atan2(math.sin(phi1 - phi0), math.cos(phi1 - phi0)))
        print(f"\n  라이다  벽거리 {d0*1000:.1f} → {d1*1000:.1f} mm  "
              f"(진행방향 변화 {dd*1000:+.1f} mm)")
        print(f"  주행 중 벽 법선 회전 {rot:+.2f}°   ← 0에 가까울수록 직진")
        if d_enc > 0.02:
            ratio = dd / d_enc
            ratio_c = max(-1.0, min(1.0, ratio))
            print(f"\n  라이다/엔코더 = {ratio:.4f}"
                  f"  → 주행방향과 벽법선 사이 각 {math.degrees(math.acos(abs(ratio_c))):.2f}°")
            print(f"  (벽법선 {math.degrees(phi0):+.2f}° 기준 → "
                  f"전진축 후보 "
                  f"{math.degrees(phi0)+math.degrees(math.acos(abs(ratio_c))):+.2f}° 또는 "
                  f"{math.degrees(phi0)-math.degrees(math.acos(abs(ratio_c))):+.2f}°)")
    scan.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
