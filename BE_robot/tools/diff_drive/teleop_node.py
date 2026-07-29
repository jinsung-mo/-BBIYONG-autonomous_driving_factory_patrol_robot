#!/usr/bin/env python3
"""수동 조종 브리지 — 대시보드가 떨군 명령 파일을 읽어 /cmd_vel 로 낸다.

    python3 teleop_node.py [--cmd-file /tmp/orincar_drive.json]

왜 파일 경유인가
  `server.py` 는 **표준 라이브러리만** 쓴다는 규범이 있다(로봇에 의존성을 안 늘린다).
  ROS 발행은 rclpy 가 필요하므로 그 부분만 이 프로세스로 떼어낸다.
  nav_bridge.py·camera_node.py 와 같은 구조다.

🔴 안전 설계 — 인터넷에서 물리 로봇을 움직이는 경로다
  ① **기본 비활성.** `armed:true` 가 명시돼야만 움직인다
  ② **데드맨 0.4초.** 명령이 끊기면 즉시 정지. 버튼에서 손을 떼면 선다
     (esp32_base_node 0.5초 + 펌웨어 1초와 3중)
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
RAMP_S = 2.0             # 꾹 누르면 이 시간에 걸쳐 0 → 명령속도까지 선형 가속.
                         #   ① 조작감: 톡 누르면 안 가고 꾹 누르면 급발진하던 것을 없앤다
                         #   ② 부수효과: 정지→최대속도 급명령이 적분을 급하게 튀게 해
                         #      좌우가 순차로 풀리는 구간을 만든다(출발 1초가 전체 요각의
                         #      67%). 완만히 올리면 그 구간이 줄어든다.
                         #   회전(w)은 램프하지 않는다 — 미세 자세 조정이 둔해진다.
DECEL_MPS2 = 0.3         # 🆕 감속 기울기 m/s². 0.3m/s → 1.0초, 1.0m/s → 3.3초에 정지.
                         #   손을 떼면 펌웨어 PID 가 목표 0 을 맞추려 **역토크를 걸어**
                         #   툭 선다(전원이 끊겨 미끄러지는 게 아니다. MDD10A 는 duty 0
                         #   에서 모터 양단을 단락시키는 단락제동이라 coast 도 아니다).
                         #   목표속도를 완만히 내려 그 역토크를 없앤다.
                         #
                         # 🔴 **의도적 정지에만 적용한다.** v=0 에 도달하는 경로는 넷인데
                         #    ① 명령없음 ② armed=false ③ 데드맨 ④ 순찰차단 은 전부
                         #    "로봇이 통제 밖"이라는 뜻이라 즉시 서야 한다. 거기에 램프를
                         #    걸면 통신이 끊겼을 때 로봇이 더 굴러간다 — 안전장치 무력화다.
                         #    버튼을 뗀 경우만 armed=true·신선한 ts·v=0 으로 들어오므로
                         #    아래 else 분기에서만 감속시킨다.


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
        self.drive_t0 = None          # 연속 전·후진이 시작된 시각 (램프 기준점)
        self.v_out = 0.0              # 🆕 직전에 실제로 발행한 v. 감속 램프의 출발점이다.
                                      #    항상 "마지막으로 내보낸 값"과 같게 유지한다 —
                                      #    라이다 가드가 v 를 0 으로 죽인 경우도 포함해야
                                      #    다음 틱이 있지도 않은 속도에서 감속을 시작하지 않는다.
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
        c = self.read_cmd()
        now = time.time()

        # 🔴 아래 네 분기는 전부 **안전 경로**다 — v_out 을 즉시 0 으로 버린다.
        #    감속 램프를 태우면 안 된다(DECEL_MPS2 주석 참조).
        if c is None:
            reason = "명령 없음"
            self.v_out = 0.0
        elif not c.get("armed"):
            reason = "비활성 (armed=false)"
            self.v_out = 0.0
        elif now - float(c.get("ts", 0)) > DEADMAN_S:
            reason = f"데드맨 — 명령이 {now - float(c.get('ts', 0)):.1f}s 지났다"
            self.v_out = 0.0
        elif now - self.patrol_seen < 5.0:
            reason = "순찰 실행 중 — 수동 차단 (같은 토픽 충돌 방지)"
            self.v_out = 0.0
        else:
            v = max(-V_MAX, min(V_MAX, float(c.get("v", 0.0))))
            w = max(-W_MAX, min(W_MAX, float(c.get("w", 0.0))))

            # 램프 — 명령이 **연속으로 유지된 시간**에 비례해 0 → v 까지 올린다.
            # 손을 떼면 데드맨이 v=0 을 만들고, 그때 기준점이 지워져 다음 출발은
            # 다시 0 부터 시작한다. 방향이 바뀌어도 부호가 뒤집히며 자연히 재시작된다.
            if abs(v) > 1e-3:
                if self.drive_t0 is None:
                    self.drive_t0 = now
                v *= min(1.0, (now - self.drive_t0) / RAMP_S)
            else:
                # 🆕 감속 램프. 여기 오는 v=0 은 **버튼을 뗀 것**이다
                #    (armed=true · 신선한 ts · 값만 0). 안전 정지는 위 elif 에서
                #    이미 걸러졌으므로 여기서 완만히 내려도 안전장치를 깎지 않는다.
                self.drive_t0 = None
                step = DECEL_MPS2 / RATE_HZ
                decayed = max(0.0, abs(self.v_out) - step)
                v = math.copysign(decayed, self.v_out) if decayed > 0 else 0.0
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

        # 🆕 v_out 은 **실제로 내보낸 값**과 항상 같아야 한다. 라이다 가드가 v 를
        #    0 으로 죽인 경우도 여기서 반영되므로, 다음 틱이 있지도 않은 속도에서
        #    감속을 시작하는 일이 없다(가드 정지는 즉시 정지로 남는다).
        self.v_out = v

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
