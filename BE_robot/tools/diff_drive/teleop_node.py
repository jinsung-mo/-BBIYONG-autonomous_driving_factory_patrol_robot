#!/usr/bin/env python3
"""수동 조종 브리지 — 대시보드가 떨군 명령 파일을 읽어 /cmd_vel 로 낸다.

    python3 teleop_node.py [--cmd-file /tmp/orincar_drive.json]

왜 파일 경유인가
  `server.py` 는 **표준 라이브러리만** 쓴다는 규범이 있다(로봇에 의존성을 안 늘린다).
  ROS 발행은 rclpy 가 필요하므로 그 부분만 이 프로세스로 떼어낸다.
  nav_bridge.py·camera_node.py 와 같은 구조다.

🔴 안전 설계 — 인터넷에서 물리 로봇을 움직이는 경로다
  ① **기본 비활성.** `armed:true` 가 명시돼야만 움직인다
  ② **데드맨 0.4초.** 명령이 끊기면 정지. 버튼에서 손을 떼면 선다
     (esp32_base_node 0.5초 + 펌웨어 1초와 3중)
     🔄 2026-07-30: 데드맨은 이제 **즉시 0 이 아니라 A_DEADMAN(0.6 m/s²) 으로
     감속**한다. 핫스팟 시연에서 패킷이 자주 끊겨 매번 울컥이던 것을 없앤다.
     비활성(armed=false)·순찰 차단은 그대로 즉시 0 이다.
  ③ **속도 상한** — 조종자는 카메라 한 대로만 보므로 사각이 크다. 보수적으로 잡는다
  ④ **라이다 충돌 가드** — 진행 방향 STOP_M 안에 뭔가 있으면 그 방향 성분을 죽인다.
     회전은 허용한다(빠져나와야 하므로)
  ⑤ **순찰 동시실행 거부** — patrol.py 도 /cmd_vel 을 낸다. 둘이 같이 쏘면
     서로 다른 명령이 번갈아 나가 예측 불가능해진다. 순찰이 돌면 수동을 막는다

명령 파일 형식 (server.py 가 POST /api/drive 로 받아 쓴다)
  {"armed": true, "v": 0.10, "w": 0.0, "ts": 1785...}
    v  전진 m/s (+앞)   w  회전 rad/s (+좌)
"""
import argparse
import json
import math
import os
import subprocess
import time

import numpy as np
import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String

CMD_FILE = "/tmp/orincar_drive.json"
STATUS_FILE = "/tmp/orincar_drive_status.json"

DEADMAN_S = 0.4          # 명령이 이보다 오래되면 정지
RATE_HZ = 20.0
V_MAX = 1.00             # m/s — 2026-07-27 0.15 → 0.50 → 1.00 상향 (사용자 결정, 실주행 확인)
                         #   🔴 **server.py 의 DRIVE_V_MAX 와 반드시 같은 값이어야 한다.**
                         #   한쪽만 올리면 낮은 쪽이 이겨 아무 변화가 없다(실제로 겪었다).
                         #   참고: 모터 정격 531rpm · 유효지름 62.29mm → 이론 최대 약 1.73 m/s.
                         #   1.00 은 그 58%다. duty_max=80 제약으로 실제 도달치는 더 낮을 수 있다.
                         #   ⚠️ 0.4s 데드맨 동안 1.0 m/s 면 40cm 를 더 간다 — 라이다 가드
                         #   STOP_M=0.35 보다 크다. 즉 **가드는 이 속도에서 제동을 보장하지 못한다.**
                         #   사람이 보고 있다는 전제로 운용한다(사용자 판단 2026-07-27).
W_MAX = 0.60             # rad/s
STOP_M = 0.35            # 진행 방향 이 안쪽이면 전진 성분 차단
CONE_DEG = 40.0

# ── 가감속 (2026-07-30 신설) ──────────────────────────────────────────────
#  종전엔 **램프가 경과시간 기반**이었다(RAMP_S=2.0, `v *= (now-t0)/RAMP_S`).
#  그게 후진→전진 급전환에서 울컥이던 원인이다: 부호가 뒤집혀도 `abs(v)>1e-3`
#  이라 t0 가 지워지지 않아 계수가 1.0 그대로였고, 목표가 −1.0 → +1.0 으로
#  **2.0 m/s 계단 점프**했다. PID 가 그 오차에 duty 를 반대로 꽂는다.
#  (그 코드의 주석은 "방향이 바뀌면 자연히 재시작된다"고 했지만 사실이 아니었다.)
#
#  이제 **출력값 슬루 리미터**다. v_out 을 상태로 들고 목표까지 가속도 상한
#  안에서만 움직인다. 부호 전환이 반드시 0 을 통과하므로 전·후진 급전환이
#  직진 감속과 **같은 메커니즘**이 된다.
A_ACC = 0.50             # m/s² 가속 상한. 종전 V_MAX/RAMP_S = 1.00/2.0 과 같은 기울기다
                         #   → 톡 누르면 안 가고 꾹 누르면 급발진하던 것을 막는 효과는 유지된다
A_DEC = 0.50             # m/s² 감속·역방향 상한 (2026-07-30 사용자 요청: 0.3 → 0.5)
A_REL = 1.50             # m/s² 손을 뗐을 때(명령 중립)의 감속. A_DEC 보다 빨라야 한다 —
                         #   안전 계약 ②가 "버튼에서 손을 떼면 선다"이므로 0.5 로 두면
                         #   1.0 m/s 에서 2초·1m 를 더 간다. 그건 데드맨 정신에 어긋난다.
                         #   회전(w)은 슬루하지 않는다 — 미세 자세 조정이 둔해진다.
A_DEADMAN = 0.60         # m/s² **데드맨이 걸렸을 때**의 감속 (2026-07-30 사용자 요청).
                         #   왜 즉시 0 이 아닌가: 모바일 핫스팟으로 시연하면 패킷이
                         #   자주 끊겨 데드맨이 수시로 걸린다. 매번 0 으로 끊으면
                         #   그때마다 울컥인다. 부드럽게 세우고, 명령이 돌아오면
                         #   그 지점에서 다시 이어받는다.
                         #   ⚠️ 비활성(armed=false)·순찰 차단은 여전히 **즉시 0** 이다 —
                         #   그건 통신 문제가 아니라 명시적 정지 의사표시다.


class Teleop(Node):
    def __init__(self, cmd_file):
        super().__init__("teleop_bridge")
        self.cmd_file = cmd_file
        self.scan = None
        self.create_subscription(LaserScan, "/scan", self._scan, qos_profile_sensor_data)
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.pub_status = self.create_publisher(String, "/teleop/status", 10)
        self.last_reason = ""
        self.stop_frames = 0
        self.patrol_seen = 0.0
        self.v_out = 0.0              # 실제로 내보낸 선속도 — 슬루 리미터의 상태
        self.create_timer(1.0 / RATE_HZ, self.tick)
        self.create_timer(2.0, self.check_patrol)
        self.get_logger().info(
            f"수동 조종 대기 · 명령파일 {cmd_file} · "
            f"상한 v={V_MAX} w={W_MAX} · 데드맨 {DEADMAN_S}s")

    def _scan(self, m):
        self.scan = m

    def check_patrol(self):
        """patrol.py 가 돌면 수동을 막는다 — 같은 토픽을 두 곳에서 쏘면 안 된다."""
        try:
            out = subprocess.run(["pgrep", "-f", "patrol" + ".py"],
                                 capture_output=True, timeout=2)
            if out.returncode == 0 and out.stdout.strip():
                self.patrol_seen = time.time()
        except Exception:
            pass

    def cone_min(self, heading_rad, half=CONE_DEG):
        """진행방향 콘 안의 최근접점을 (거리 m, 방위 deg) 로 돌려준다.

        방위는 **진행방향 기준** 상대각이다(+가 좌측). 거리만 알면
        "어디가 막혔는지" 몰라서 빠져나갈 방향을 못 고른다 — 실제로
        전·후진이 둘 다 막힌 줄 알고 헤맸다(2026-07-27).
        """
        m = self.scan
        if m is None:
            return None
        n = len(m.ranges)
        a = m.angle_min + np.arange(n) * m.angle_increment
        r = np.asarray(m.ranges, dtype=float)
        ok = np.isfinite(r) & (r > m.range_min) & (r < m.range_max)
        a, r = a[ok], r[ok]
        if len(r) == 0:
            return None
        d = np.arctan2(np.sin(a - heading_rad), np.cos(a - heading_rad))
        sel = np.abs(d) <= math.radians(half)
        if not sel.any():
            return None
        i = int(np.argmin(r[sel]))
        return float(r[sel][i]), float(math.degrees(d[sel][i]))

    def read_cmd(self):
        try:
            with open(self.cmd_file) as f:
                return json.load(f)
        except (FileNotFoundError, ValueError, OSError):
            return None

    def tick(self):
        v = w = 0.0
        reason = ""
        hard = True                   # 즉시 0 (비상). 정상 명령이면 아래에서 해제된다
        coast_a = None                # 목표 0 으로 슬루할 때 쓸 감속도 (데드맨용)
        c = self.read_cmd()
        now = time.time()

        if c is None:
            reason = "명령 없음"
        elif not c.get("armed"):
            reason = "비활성 (armed=false)"
        elif now - float(c.get("ts", 0)) > DEADMAN_S:
            # 핫스팟 시연에서는 이 경로가 자주 밟힌다. 끊지 말고 A_DEADMAN 으로 세운다.
            reason = f"데드맨 — 명령이 {now - float(c.get('ts', 0)):.1f}s 지났다"
            hard, coast_a = False, A_DEADMAN
        elif now - self.patrol_seen < 5.0:
            reason = "순찰 실행 중 — 수동 차단 (같은 토픽 충돌 방지)"
        else:
            hard = False
            v = max(-V_MAX, min(V_MAX, float(c.get("v", 0.0))))
            w = max(-W_MAX, min(W_MAX, float(c.get("w", 0.0))))

            # 라이다 가드: 진행 방향이 막혔으면 그 성분만 죽인다. 회전은 살린다
            # (막힌 데서 빠져나오려면 돌 수 있어야 한다).
            if abs(v) > 1e-3:
                heading = 0.0 if v > 0 else math.pi
                hit = self.cone_min(heading)
                if hit is not None and hit[0] < STOP_M:
                    near, bear = hit
                    where = "정면" if abs(bear) < 5 else (
                        f"{'좌' if bear > 0 else '우'}{abs(bear):.0f}°")
                    reason = (f"라이다 가드 — {'전진' if v > 0 else '후진'} "
                              f"{where} {near * 100:.0f}cm")
                    v = 0.0
            if not reason:
                reason = "주행 중" if (abs(v) > 1e-3 or abs(w) > 1e-3) else "정지"

        # 슬루 리미터 — 목표까지 가속도 상한 안에서만 움직인다. 부호 전환이
        # 반드시 0 을 통과하므로 후진↔전진 급전환이 직진 감속과 **같은 경로**를
        # 탄다. 이게 울컥임의 해법이다.
        # 비상 경로(비활성·순찰·명령없음)는 슬루하지 않고 즉시 0 이다 —
        # "버튼에서 손을 떼면 선다"는 안전 계약을 지연시켜선 안 된다.
        if hard:
            self.v_out = 0.0
        else:
            if coast_a is not None:
                a = coast_a                     # 데드맨 — 끊지 않고 이 감속도로 세운다
            elif abs(v) < 1e-3:
                a = A_REL                       # 중립 — 빠르게 세운다
            elif abs(v) < abs(self.v_out) or v * self.v_out < 0.0:
                a = A_DEC                       # 감속 또는 역전
            else:
                a = A_ACC
            step = a / RATE_HZ
            self.v_out = (min(v, self.v_out + step) if v > self.v_out
                          else max(v, self.v_out - step))
        v = self.v_out

        # 🔴 **명령하지 않을 때는 발행하지 않는다.**
        #    같은 토픽에 퍼블리셔가 둘이면 마지막 메시지가 이긴다. 여기서
        #    20Hz 로 0을 계속 쏘면 patrol 의 10Hz 주행 명령을 덮어써
        #    **로봇이 제자리에 선다** — 실제로 수집 주행 5세션이 통째로
        #    제자리 회전만 하다 끝났다(병진 경로장 0.00m).
        #    "0을 보내는 것"과 "안 보내는 것"은 전혀 다르다.
        #    비활성 전환 직후에만 확실한 정지를 위해 몇 프레임 0을 보낸다.
        active = abs(v) > 1e-4 or abs(w) > 1e-4
        if active:
            t = Twist()
            t.linear.x, t.angular.z = v, w
            self.pub.publish(t)
            self.stop_frames = 6          # 다음에 멈출 때 보낼 0 프레임 수
        elif getattr(self, "stop_frames", 0) > 0:
            self.pub.publish(Twist())
            self.stop_frames -= 1

        if reason != self.last_reason:
            self.last_reason = reason
            self.get_logger().info(f"[{reason}] v={v:.3f} w={w:.3f}")
        st = {"t": now, "v": v, "w": w, "reason": reason,
              "v_max": V_MAX, "w_max": W_MAX, "stop_m": STOP_M,
              "patrol_running": now - self.patrol_seen < 5.0}
        self.pub_status.publish(String(data=json.dumps(st)))
        tmp = STATUS_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(st, f)
            os.replace(tmp, STATUS_FILE)
        except OSError:
            pass

    def shutdown(self):
        for _ in range(5):
            self.pub.publish(Twist())
            time.sleep(0.05)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmd-file", default=CMD_FILE, dest="cmd_file")
    a = ap.parse_args()
    rclpy.init()
    node = Teleop(a.cmd_file)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.shutdown()          # 🔴 어떤 경로로 끝나든 정지 명령을 남긴다
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
