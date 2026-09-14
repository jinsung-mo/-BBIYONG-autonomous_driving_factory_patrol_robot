#!/usr/bin/env python3
"""반응형 탐색 주행 — 라이다만 보고 빈 곳으로 굴러간다.

Nav2·SLAM 없이 도는 최소 자율주행이다. 목적은 두 가지:
  1. 로봇이 실제로 집 안을 돌아다닐 수 있는지 확인
  2. 그러면서 오도메트리·라이다 데이터를 쌓아 다음 단계(매핑)의 근거를 만든다

    python3 roam.py [주행초] [속도]
    예) python3 roam.py 60 0.12

동작
  · 전방 부채꼴이 트여 있으면 직진
  · 막히면 제자리 회전으로 가장 트인 방향을 찾아 돌린 뒤 다시 직진
  · 어느 순간이든 진행 방향 STOP_M 이내에 뭔가 있으면 즉시 정지

🔴 안전 3중
  1. 매 제어주기 라이다 확인 (여기)
  2. 예외·종료 시 finally 정지 (여기)
  3. 펌웨어 데드맨 1초 — 스크립트가 죽어도 로봇은 선다
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
from bench import Bot                     # noqa: E402

MM_PER_COUNT = 0.16348
TRACK_M = 0.202                            # [실측] §K

STOP_M = 0.28                              # 진행 방향 이 안쪽이면 정지
CLEAR_M = 0.55                             # 이보다 트여야 직진
CONE_DEG = 45.0                            # 전방 판단 부채꼴 반각
TURN_SPEED = 0.10                          # 제자리 회전 시 바퀴 속도
CTRL_HZ = 8.0


class Roamer(Node):
    def __init__(self, forward_deg=0.0):
        super().__init__("roamer")
        self.last = None
        self.fwd = math.radians(forward_deg)   # 라이다 프레임에서의 전진축
        self.create_subscription(LaserScan, "/scan", self._cb, qos_profile_sensor_data)

    def _cb(self, msg):
        self.last = msg

    def wait_scan(self, timeout=3.0):
        t0 = time.time()
        while self.last is None and time.time() - t0 < timeout:
            rclpy.spin_once(self, timeout_sec=0.05)
        return self.last

    def polar(self, msg):
        n = len(msg.ranges)
        a = msg.angle_min + np.arange(n) * msg.angle_increment
        r = np.asarray(msg.ranges, dtype=float)
        ok = np.isfinite(r) & (r > msg.range_min) & (r < msg.range_max)
        return a[ok], r[ok]

    def cone_min(self, msg, heading, half_deg=CONE_DEG):
        a, r = self.polar(msg)
        if len(r) == 0:
            return float("inf")
        d = np.arctan2(np.sin(a - heading), np.cos(a - heading))
        sel = np.abs(d) <= math.radians(half_deg)
        return float(r[sel].min()) if sel.any() else float("inf")

    def best_heading(self, msg, half_deg=30.0):
        """가장 트인 방향(부채꼴 최소거리가 최대인 방향)을 고른다."""
        a, r = self.polar(msg)
        if len(r) == 0:
            return self.fwd, 0.0
        best_h, best_v = self.fwd, -1.0
        for deg in range(-180, 180, 10):
            h = math.radians(deg)
            d = np.arctan2(np.sin(a - h), np.cos(a - h))
            sel = np.abs(d) <= math.radians(half_deg)
            if not sel.any():
                continue
            v = float(r[sel].min())
            if v > best_v:
                best_h, best_v = h, v
        return best_h, best_v


def ang_diff(a, b):
    return math.atan2(math.sin(a - b), math.cos(a - b))


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 45.0
    speed = float(sys.argv[2]) if len(sys.argv) > 2 else 0.12
    fwd_deg = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0

    rclpy.init()
    node = Roamer(fwd_deg)
    if node.wait_scan() is None:
        print("라이다 없음")
        return 1

    bot = Bot()
    time.sleep(0.5)
    bot.reset_counts()

    t0 = time.time()
    state, turn_target, n_turn, n_fwd = "FWD", None, 0, 0
    dt = 1.0 / CTRL_HZ
    log = []
    try:
        while time.time() - t0 < secs:
            rclpy.spin_once(node, timeout_sec=0.02)
            msg = node.last
            if msg is None:
                continue
            ahead = node.cone_min(msg, node.fwd)

            if state == "FWD":
                if ahead < CLEAR_M:
                    bot.stop()
                    h, v = node.best_heading(msg)
                    turn_target = h
                    state = "TURN"
                    n_turn += 1
                    print(f"[{time.time()-t0:5.1f}s] 전방 {ahead*1000:.0f}mm 막힘 "
                          f"→ {math.degrees(h):+.0f}° 방향으로 회전 (트임 {v*1000:.0f}mm)")
                    continue
                bot.send(f"v {speed:.4f} {speed:.4f}")
                n_fwd += 1
            else:  # TURN — 제자리 회전
                err = ang_diff(turn_target, node.fwd)
                # 회전이 끝났는지는 "전방이 트였는지"로 판정한다.
                # yaw를 적분해 추적하면 오도메트리 오차가 그대로 쌓인다.
                if ahead > CLEAR_M * 1.15:
                    bot.stop()
                    state = "FWD"
                    print(f"[{time.time()-t0:5.1f}s] 전방 {ahead*1000:.0f}mm 확보 → 직진")
                    time.sleep(0.2)
                    continue
                s = TURN_SPEED if err > 0 else -TURN_SPEED
                bot.send(f"v {s:.4f} {-s:.4f}")     # 좌우 반대 = 제자리 회전

            log.append((time.time() - t0, state, ahead))
            time.sleep(dt)
    except KeyboardInterrupt:
        print("\n중단됨")
    finally:
        bot.stop()
        time.sleep(0.3)
        try:
            rows = bot.read_telemetry(0.4)
            if rows:
                lc, rc = rows[-1][8], rows[-1][9]
                dist = (abs(lc) + abs(rc)) / 2.0 * MM_PER_COUNT / 1000.0
                yaw = (lc - rc) * MM_PER_COUNT / 1000.0 / TRACK_M
                print(f"\n  엔코더 누적  좌 {lc:+d}  우 {rc:+d}")
                print(f"  이동거리(경로장) {dist:.2f} m · 누적 회전 "
                      f"{math.degrees(yaw):+.0f}°")
        except Exception:
            pass
        bot.close()

    print(f"  직진 {n_fwd}틱 · 회전 {n_turn}회 · {time.time()-t0:.0f}초")
    if log:
        mins = [x[2] for x in log if math.isfinite(x[2])]
        if mins:
            print(f"  전방 최소거리 최소값 {min(mins)*1000:.0f} mm "
                  f"(안전한계 {STOP_M*1000:.0f} mm)")
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
