#!/usr/bin/env python3
"""순찰 주행 — 라이다 + 카메라 융합 자율주행.

    python3 patrol.py [주행초] [속도] [각속도]

roam_ros.py 가 라이다만 봤다면, 이건 카메라를 더한다.

왜 카메라가 필요한가
  🔴 **라이다 스캔면은 지상 약 200mm 다.** 그보다 낮은 것은 라이다에
     존재하지 않는다 — 신발·전선·문턱·가구 다리 밑동.
     실제로 카메라 영상에서 바닥의 전선과 의자 다리가 확인됐다.
  카메라의 `/camera/floor_clear` 는 좌·중·우 3구획이 얼마나 트였는지(0~1)를
  준다. 미터가 아니라 **상대값**이다(카메라 자세 캘리브레이션 없음).
  회피에는 "어느 쪽이 더 막혔나"만 있으면 충분하다.

판단 우선순위
  1. 화재 탐지 → 즉시 정지하고 보고 (임무)
  2. **생물 근접(사람·동물) → 정지하고 기다린다** — 회피 기동으로 다가가는 것보다
     서 있는 쪽이 안전하고 상대가 예측하기 쉽다
  3. 라이다 전방 막힘 → 회전
  4. 카메라 바닥 막힘 → 감속 + 트인 쪽으로 조향
  5. 그 외 → 직진

카메라 ↔ 라이다 융합 (`range_at`)
  COCO 박스 중심 x → 방위각 → 라이다에서 그 각도의 거리 조회.
  3D 캘리브레이션 불필요 — 2D 스캔이라 높이 자유도가 없고, 이 한 방향만
  쓰면 **수평화각과 요 오프셋 2개**면 된다.
  ⚠️ `CAM_HFOV_DEG` 는 아직 [추정]이다. 틀리면 거리 매칭이 어긋난다.
     라이다가 정확히 아는 지점(벽 모서리)을 화면에서 찾아 실측할 것.

⚠️ 알고 있는 한계
  · 카메라 바닥 판정은 **바닥과 같은 색인 장애물을 못 본다**(흰 바닥 위 흰 전선)
  · COCO 80종에 없는 것(전선·문턱)은 **이름이 안 붙는다** — 다만 바닥 판정과
    라이다가 회피는 시킨다
  · **"밟고 넘어가도 되는가"는 판정하지 않는다.** 박스만으로는 높이를 알 수 없다
    (바닥의 책 vs 의자 위의 책이 같아 보인다). 깊이 센서 영역이고 이번엔 제외
"""
import json
import math
import sys
import time

import numpy as np
import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan
from std_msgs.msg import Bool, Float32MultiArray, String

CLEAR_M = 0.60
RESUME_M = 0.75
CONE_DEG = 45.0
CTRL_HZ = 10.0

FLOOR_SLOW = 0.55      # 이 밑이면 감속
FLOOR_BLOCK = 0.30     # 이 밑이면 그 방향은 막힌 것으로 본다
FLOOR_FREE = 0.45      # 회전을 끝내려면 이 위여야 한다 (히스테리시스)
CAM_STALE_S = 2.0      # 카메라 신호가 이보다 오래되면 무시(라이다만으로 주행)

MIN_TURN_S = 1.2       # 회전에 들어갔으면 최소 이만큼은 돈다
# 🔴 카메라 거부권의 시한. 카메라가 계속 "막혔다"고 하는데 라이다는 트여 있으면,
#    카메라가 바닥이 아닌 것을 기준으로 삼았을 가능성이 크다(가구 밑 등).
#    시한이 없으면 로봇이 영원히 못 움직인다 — 센서 하나가 임무를 죽여선 안 된다.
CAM_VETO_MAX_S = 8.0
CAM_VETO_COOLDOWN_S = 12.0

# 생물이 이 거리 안에 있으면 정지 (라이다 거리 매칭 실패 시에도 보수적으로 정지)
LIVING_STOP_M = 1.5
# 🔴 다만 **무한히 기다리지는 않는다.** 사람이 로봇을 지켜보며 가만히 서 있으면
#    영원히 안 비킨다 — 실측: 200초 중 190초를 person 61cm 앞에서 멈춰 있었다.
#    이건 카메라 거부권과 같은 종류의 문제다. "항상 막혔다고 말하는 조건이
#    임무를 영구히 멈출 수 있으면 안 된다."
#    이 시간을 넘기면 정지한 생물을 **일반 장애물로 재분류**해 우회한다.
# 🔴 12초 → 4초. **완벽한 분류를 하류에서 만들려 하지 말고 피해를 유계로 만든다.**
#    COCO 가 0.85 확신으로 빨래를 person 이라 부르는 이상(실측 오탐률 55%),
#    뒤에서 거르는 규칙을 정교하게 짜도 근본은 안 고쳐진다.
#    오판이 나도 4초만 서고 우회하면 순찰은 계속된다.
#    진짜 사람이면 4초는 비켜주기에 충분하고, 안 비키면 우회가 맞다.
#    **근본 해법은 파인튜닝이다** — docs/파인튜닝_가이드.md
LIVING_WAIT_MAX_S = 4.0
LIVING_COOLDOWN_S = 15.0

# 🔴 유령 person 대응 — **움직이지 않으면 생물이 아니다**
#    COCO 가 널린 청바지·옷걸이를 person 0.85 로 잡는다(실측: 사람 없는 장면
#    40프레임 중 40프레임, 세션 438프레임 중 240프레임=55%).
#    모델을 3배 키워도 39/40 이라 **크기 문제가 아니라 도메인 문제**다.
#    임계값도 소용없다 — 오탐 confidence 가 0.85 로 진짜보다 높다.
#
#    쓸 수 있는 신호는 **운동**이다. 사람은 가만히 서 있어도 방위·거리가
#    미세하게 흔들리지만 빨래는 안 흔들린다. 실제로 앞선 사건에서 거리가
#    **190초 내내 정확히 61cm** 로 고정돼 있었고, 그게 사람이 아니라는 단서였다.
#    → 일정 시간 완전히 정지해 있으면 **생물 자격을 박탈**하고 일반 장애물로 본다.
LIVING_MOTION_WINDOW_S = 4.0    # 이 시간만큼의 이력을 본다
LIVING_MOTION_MIN_M = 0.04      # 거리 변화폭이 이보다 작으면 정물
LIVING_MOTION_MIN_RAD = 0.035   # 방위 변화폭이 이보다 작으면 정물 (약 2°)


class Patrol(Node):
    def __init__(self, fwd_deg=0.0):
        super().__init__("patrol")
        self.scan = None
        self.fwd = math.radians(fwd_deg)
        self.floor = None
        self.floor_t = 0.0
        self.fire = False
        self.fire_t = 0.0
        self.create_subscription(LaserScan, "/scan", self._scan, qos_profile_sensor_data)
        self.create_subscription(Float32MultiArray, "/camera/floor_clear",
                                 self._floor, 10)
        self.create_subscription(Bool, "/camera/fire", self._fire, 10)
        self.create_subscription(String, "/camera/objects", self._objs, 10)
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.objs, self.objs_t = [], 0.0

    def _objs(self, m):
        try:
            self.objs, self.objs_t = json.loads(m.data), time.time()
        except Exception:
            pass

    def objs_fresh(self):
        if time.time() - self.objs_t > CAM_STALE_S:
            return []
        return self.objs

    def range_at(self, bearing_rad, half_deg=4.0):
        """라이다에서 그 방위각의 거리. 카메라 박스 ↔ 라이다 거리를 잇는 다리.

        3D 캘리브레이션이 필요 없다 — 2D 스캔이라 높이 자유도가 애초에 없고,
        박스→방위각→거리 한 방향만 쓰면 수평화각과 요 오프셋 2개면 된다.
        """
        if self.scan is None:
            return None
        a, r = self.polar()
        if len(r) == 0:
            return None
        d = np.arctan2(np.sin(a - bearing_rad), np.cos(a - bearing_rad))
        sel = np.abs(d) <= math.radians(half_deg)
        if not sel.any():
            return None
        return float(np.median(r[sel]))     # 중앙값 — 박스 가장자리 잡음에 강하다

    def _scan(self, m):
        self.scan = m

    def _floor(self, m):
        if len(m.data) == 3:
            self.floor, self.floor_t = list(m.data), time.time()

    def _fire(self, m):
        self.fire, self.fire_t = bool(m.data), time.time()

    def floor_fresh(self):
        if self.floor is None or time.time() - self.floor_t > CAM_STALE_S:
            return None
        return self.floor

    def polar(self):
        m = self.scan
        n = len(m.ranges)
        a = m.angle_min + np.arange(n) * m.angle_increment
        r = np.asarray(m.ranges, dtype=float)
        ok = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
        return a[ok], r[ok]

    def cone_min(self, heading, half=CONE_DEG):
        a, r = self.polar()
        if len(r) == 0:
            return float("inf")
        d = np.arctan2(np.sin(a - heading), np.cos(a - heading))
        sel = np.abs(d) <= math.radians(half)
        return float(r[sel].min()) if sel.any() else float("inf")

    def best_dir(self, half=30.0):
        a, r = self.polar()
        if len(r) == 0:
            return self.fwd, 0.0
        bh, bv = self.fwd, -1.0
        for deg in range(-180, 180, 10):
            h = math.radians(deg)
            d = np.arctan2(np.sin(a - h), np.cos(a - h))
            sel = np.abs(d) <= math.radians(half)
            if not sel.any():
                continue
            v = float(r[sel].min())
            if v > bv:
                bh, bv = h, v
        return bh, bv

    def cmd(self, vx, wz):
        t = Twist()
        t.linear.x, t.angular.z = vx, wz
        self.pub.publish(t)


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 120.0
    vx = float(sys.argv[2]) if len(sys.argv) > 2 else 0.11
    wz = float(sys.argv[3]) if len(sys.argv) > 3 else 0.30

    rclpy.init()
    node = Patrol()
    t0 = time.time()
    while node.scan is None and time.time() - t0 < 6.0:
        rclpy.spin_once(node, timeout_sec=0.05)
    if node.scan is None:
        print("스캔 없음")
        return 1

    state, turn_sign = "FWD", 1.0
    turn_reason, turn_start = "lidar", 0.0
    cam_block_since = None       # 카메라가 연속으로 막혔다고 한 시작 시각
    cam_veto_until = 0.0         # 이 시각까지는 카메라 회전 트리거를 무시
    n_turn = n_slow = n_steer = n_veto = n_living = n_living_giveup = 0
    last_living_log = 0.0
    living_block_since = None    # 생물 때문에 멈춰 있기 시작한 시각
    living_track = {}            # name → [(t, bearing, range), ...] 운동 판정용
    n_ghost = 0                  # 정물로 판정해 무시한 횟수
    living_ignore_until = 0.0    # 이 시각까지는 생물 정지를 보류(우회 중)
    fire_events = []
    cam_seen = False
    t0 = time.time()
    try:
        while time.time() - t0 < secs:
            rclpy.spin_once(node, timeout_sec=0.02)
            if node.scan is None:
                continue
            now = time.time()

            # ① 화재 — 최우선. 임무이므로 주행을 멈추고 보고한다.
            if node.fire and now - node.fire_t < CAM_STALE_S:
                node.cmd(0.0, 0.0)
                if not fire_events or now - fire_events[-1] > 5.0:
                    fire_events.append(now)
                    print(f"[{now-t0:6.1f}s] 🔥 화재 탐지 — 정지·보고")
                time.sleep(0.3)
                continue

            ahead = node.cone_min(node.fwd)
            floor = node.floor_fresh()
            if floor is not None:
                cam_seen = True

            # ①-b 생물 감지 → 정지하고 기다린다.
            #     사람·동물은 스스로 비켜 준다. 회피 기동으로 다가가는 것보다
            #     서 있는 쪽이 안전하고 예측 가능하다.
            living = [o for o in node.objs_fresh() if o.get("living")]
            near = []
            for o in living:
                rng = node.range_at(o["bearing"])
                # 운동 이력 기록 (거리를 못 재면 방위만이라도 본다)
                h = living_track.setdefault(o["name"], [])
                h.append((now, o["bearing"], rng))
                cut = now - LIVING_MOTION_WINDOW_S
                living_track[o["name"]] = h = [x for x in h if x[0] >= cut]

                # 창이 다 찼는데 전혀 안 움직였으면 생물이 아니다 → 무시
                if h and h[-1][0] - h[0][0] >= LIVING_MOTION_WINDOW_S * 0.8 and len(h) >= 6:
                    brg = [x[1] for x in h]
                    rs = [x[2] for x in h if x[2] is not None]
                    still_brg = (max(brg) - min(brg)) < LIVING_MOTION_MIN_RAD
                    still_rng = (len(rs) < 2) or ((max(rs) - min(rs)) < LIVING_MOTION_MIN_M)
                    if still_brg and still_rng:
                        if now - last_living_log > 5.0:
                            last_living_log = now
                            n_ghost += 1
                            print(f"[{now-t0:6.1f}s] 👻 {o['name']} 이 "
                                  f"{LIVING_MOTION_WINDOW_S:.0f}초간 미동 없음 "
                                  f"→ 정물로 판정, 생물 정지 안 함")
                        continue
                if rng is None or rng < LIVING_STOP_M:
                    near.append((o["name"], rng))
            if near and now >= living_ignore_until:
                if living_block_since is None:
                    living_block_since = now
                waited = now - living_block_since
                if waited > LIVING_WAIT_MAX_S:
                    # 안 비킨다 → 정지한 장애물로 재분류하고 우회한다.
                    living_ignore_until = now + LIVING_COOLDOWN_S
                    living_block_since = None
                    n_living_giveup += 1
                    h, v = node.best_dir()
                    turn_sign = 1.0 if math.atan2(
                        math.sin(h - node.fwd), math.cos(h - node.fwd)) > 0 else -1.0
                    state, turn_reason, turn_start = "TURN", "lidar", now
                    n_turn += 1
                    print(f"[{now-t0:6.1f}s] ⚠️ {waited:.0f}초 기다려도 안 비킨다 "
                          f"→ 정지 장애물로 보고 우회 (트임 {v*1000:.0f}mm)")
                    time.sleep(0.3)
                    continue
                node.cmd(0.0, 0.0)
                if now - last_living_log > 3.0:
                    last_living_log = now
                    n_living += 1
                    desc = ", ".join(
                        f"{nm} {'?' if d is None else f'{d*100:.0f}cm'}"
                        for nm, d in near)
                    print(f"[{now-t0:6.1f}s] 🧍 생물 근접 — 정지 ({desc}) "
                          f"{waited:.0f}/{LIVING_WAIT_MAX_S:.0f}s")
                time.sleep(0.3)
                continue
            if not near:
                living_block_since = None

            # 카메라 전면 막힘이 얼마나 이어졌는지 추적 (거부권 시한 판단용)
            cam_all_blocked = (floor is not None and max(floor) < FLOOR_BLOCK)
            if cam_all_blocked:
                if cam_block_since is None:
                    cam_block_since = now
            else:
                cam_block_since = None

            if state == "FWD":
                # ② 라이다 전방 막힘 → 회전
                if ahead < CLEAR_M:
                    node.cmd(0.0, 0.0)
                    h, v = node.best_dir()
                    turn_sign = 1.0 if math.atan2(
                        math.sin(h - node.fwd), math.cos(h - node.fwd)) > 0 else -1.0
                    state, turn_reason, turn_start = "TURN", "lidar", now
                    n_turn += 1
                    print(f"[{now-t0:6.1f}s] 라이다 전방 {ahead*1000:.0f}mm "
                          f"→ 회전 (트임 {v*1000:.0f}mm)")
                    time.sleep(0.4)
                    continue

                # ③ 카메라 바닥 — 라이다가 못 보는 낮은 것
                v_cmd, w_cmd = vx, 0.0
                if floor is not None:
                    L, C, R = floor
                    if cam_all_blocked and now >= cam_veto_until:
                        # 카메라만 오래 막고 있으면 거부권을 일시 정지한다.
                        # (가구 밑처럼 기준 패치 자체가 바닥이 아닌 상황)
                        if cam_block_since and now - cam_block_since > CAM_VETO_MAX_S:
                            cam_veto_until = now + CAM_VETO_COOLDOWN_S
                            n_veto += 1
                            print(f"[{now-t0:6.1f}s] ⚠️ 카메라가 {CAM_VETO_MAX_S:.0f}초 "
                                  f"연속 막힘인데 라이다는 트임 — 카메라 거부권 "
                                  f"{CAM_VETO_COOLDOWN_S:.0f}초 정지, 라이다로 주행")
                        else:
                            node.cmd(0.0, 0.0)
                            state, turn_reason, turn_start = "TURN", "camera", now
                            turn_sign = 1.0 if L >= R else -1.0
                            n_turn += 1
                            print(f"[{now-t0:6.1f}s] 카메라 바닥 전면 막힘 "
                                  f"{[round(x,2) for x in floor]} → 회전")
                            time.sleep(0.4)
                            continue
                    if C < FLOOR_SLOW and now >= cam_veto_until:
                        # 감속하고 더 트인 쪽으로 조향한다
                        v_cmd = vx * max(0.35, C / FLOOR_SLOW)
                        w_cmd = wz * 0.8 * (1.0 if L > R else -1.0)
                        n_slow += 1
                        if L > R:
                            n_steer += 1
                node.cmd(v_cmd, w_cmd)
            else:
                # 🔴 탈출 조건은 **진입 조건과 대칭**이어야 한다.
                #    예전엔 진입은 라이다 또는 카메라인데 탈출은 라이다만 봤다.
                #    그래서 카메라로 진입하면 라이다가 트여 즉시 빠져나오고,
                #    카메라는 또 막혔다고 해 0.5초 주기로 320회 반복했다(라이브락).
                lidar_ok = ahead > RESUME_M
                cam_ok = (turn_reason != "camera" or floor is None or
                          max(floor) > FLOOR_FREE or now >= cam_veto_until)
                long_enough = now - turn_start > MIN_TURN_S
                if lidar_ok and cam_ok and long_enough:
                    node.cmd(0.0, 0.0)
                    state = "FWD"
                    print(f"[{now-t0:6.1f}s] 전방 {ahead*1000:.0f}mm 확보"
                          f"{'' if turn_reason=='lidar' else ' · 바닥도 트임'} → 직진")
                    time.sleep(0.5)
                    continue
                # 카메라로 진입했는데 너무 오래 못 빠져나오면 거부권을 정지시킨다
                if (turn_reason == "camera" and now - turn_start > CAM_VETO_MAX_S
                        and lidar_ok):
                    cam_veto_until = now + CAM_VETO_COOLDOWN_S
                    n_veto += 1
                    print(f"[{now-t0:6.1f}s] ⚠️ 카메라 회전이 안 끝난다 — "
                          f"거부권 {CAM_VETO_COOLDOWN_S:.0f}초 정지")
                node.cmd(0.0, turn_sign * wz)
            time.sleep(1.0 / CTRL_HZ)
    except KeyboardInterrupt:
        print("\n중단")
    finally:
        for _ in range(8):
            try:
                node.cmd(0.0, 0.0)
            except Exception:
                break
            time.sleep(0.05)

    print(f"\n  {time.time()-t0:.0f}초 · 회전 {n_turn}회 · "
          f"카메라 감속 {n_slow}틱 · 화재 이벤트 {len(fire_events)}건 · "
          f"카메라 거부권 정지 {n_veto}회 · 생물 정지 {n_living}회 · "
          f"생물 우회 {n_living_giveup}회 · 정물 판정 {n_ghost}회")
    print(f"  카메라 신호 {'수신됨' if cam_seen else '없음 — 라이다만으로 주행함'}")
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
