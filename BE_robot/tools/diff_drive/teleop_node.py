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
  ④ **운동학적 제동 가드** — 진행 방향 최근접거리에서 "반응거리 + 제동거리" 를 계산해
     **STOP_M 에서 정확히 멈출 속도까지만** 허용한다(brake_limit). 종전처럼 문턱
     안에 들어와서야 0 으로 끊지 않으므로 부드럽고, 데드맨 지연이 식에 포함돼
     실제로 충돌을 막는다. 회전은 허용한다(빠져나와야 하므로).
     STOP_M 안쪽에 이미 들어와 있으면, **완전 정차 + 조작 중립 통과** 후에
     ESCAPE_V 저속 탈출을 허용한다 — 갇히지 않게.
  ⑤ **회전 우선 배분** — 직진과 회전을 같이 명령하면 그 순간의 v_ceil(도달 가능
     속도 천장) 안에서 최대한 타이트하게 돈다. 고정 반경을 두지 않는다 — 속도를
     희생해서 방향을 먼저 돌리되, 얼마나 희생할지는 실측 능력에 맡긴다.
  ⑥ **순찰 동시실행 거부** — patrol.py 도 /cmd_vel 을 낸다. 둘이 같이 쏘면
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
from nav_msgs.msg import Odometry
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

# ── 충돌 회피 제동 (2026-07-30 신설) ─────────────────────────────────────
STOP_M = 0.30            # 여기서 **완전 정지**한다 (종전 0.35 = 전진 성분 즉시 차단)
REACT_S = 0.45           # 반응 지연 — 데드맨 0.4s + 통신·직렬 여유. 제동거리에 더한다
ESCAPE_V = 0.08          # m/s STOP_M 안쪽에서 빠져나올 때의 속도 상한

# ── 정차 확인 ───────────────────────────────────────────────────────────
STOPPED_V = 0.02         # m/s odom 실측이 이보다 느리면 멈춘 것으로 본다
STOPPED_S = 0.4          # s 그 상태가 이만큼 유지되면 "완전 정차"
ODOM_STALE_S = 1.0       # s odom 이 이보다 끊기면 명령값 기준으로 폴백한다

# ── 회전 우선 배분 (2026-07-30 신설, 2026-07-30 고정반경 → 동적으로 교체) ──
#  🔴 첫 버전은 고정 반경 TURN_R_MAX=0.45m 였다(|v| ≤ |w|×0.45).
#  사용자 지적대로 **틀린 설계였다** — 출력을 올려 실제로 더 타이트하게 돌 수
#  있을 때도 0.45m 가 상한으로 눌러버리고, 출력이 약해 0.45m 도 못 낼 때는
#  계속 그 반경을 요구했다. 방향이 반대인 두 경우 모두에서 틀렸다.
#  → 고정 반경을 버리고 **그 순간 낼 수 있는 최선의 회전**을 한다: 회피가
#  실측으로 추정해 둔 v_ceil(도달 가능한 속도 천장)을 그대로 써서,
#  "빠른 쪽 바퀴가 v_ceil 을 넘지 않는 한도"까지만 v 를 허용한다.
#    half = 0.5 × TRACK_M × w        (좌우 목표 차이의 절반, 아래 tick() 참조)
#    cap  = max(0, v_ceil − half)    (빠른 쪽 바퀴 목표 = v+half 가 v_ceil 이하)
#  출력을 올리면 v_ceil 이 올라가 자동으로 더 타이트하게 돌고, 출력이 약하면
#  자동으로 완만해진다 — 상수를 안 둬도 된다.
TRACK_M = 0.2091         # m 윤거. 🔴 정본은 esp32_base_node 의 track_width_m 이다.
                         #   새 차체(윤거 ~310mm)로 옮기면 **여기도 같이 고쳐야 한다.**

# ── 포화 회피 (2026-07-30 신설) ─────────────────────────────────────────
#  🔴 **이게 직진이 휘는 근본 원인이다.**
#  esp32_base_node 가 `duty_max:=30.0` 으로 도는데, duty 100% = 무부하 588rpm
#  ≈ 1.92 m/s 이므로 v=1.00 에는 약 52% duty 가 필요하다. 즉 대시보드가 보내는
#  V_MAX 는 **도달 불가능한 목표**다.
#  양쪽 바퀴 목표(v ∓ half)가 둘 다 도달치를 넘으면 **좌우 PID 가 동시에 duty
#  상한에 붙어 조향 권한을 완전히 잃는다.** 그 상태에서는 w 를 아무리 줘도
#  좌우 차이가 안 생기고, §L 의 "우측 모터가 부하에서 약하다"가 그대로 드러나
#  오른쪽으로 휜다. 회전 보정만 넣어도 안 듣는 이유가 이것이다.
#  → **도달 가능한 속도 천장을 스스로 찾아 그 아래에 머문다.**
#    ⚠️ 첫 시도(`V_HEADROOM = 실측 + 0.15`)는 틀렸다 — 실측보다 항상 앞선 목표를
#    주면 추종오차가 영구히 남아 적분이 감기고 **여전히 포화한다.** 천장은
#    도달치 *아래*여야 좌우 조절 여유가 생긴다.
#    duty 텔레메트리를 안 쓰고 **추종오차만으로** 판정하므로, 출력 슬라이더를
#    올리거나 바닥 마찰이 바뀌어도 알아서 따라간다.
#  ⚠️ 2차 시도도 틀렸다 — "슬루가 목표에 도달했을 때만 판정" 게이트를 뒀는데
#  제동 곡선이 v_allow 를 미세하게 흔들어 **거의 항상 '가속 중'으로 판정**됐다.
#  실측: 천장이 1.0 → 0.864 에서 멈췄다(도달치는 약 0.4).
#  → 가속 판별을 목표 추종이 아니라 **"실측 속도가 더 이상 오르는가"** 로 바꾼다.
#    안 오르면서 못 따라오면 그게 포화다. 그때는 천천히 내리지 말고
#    **실측 바로 아래로 즉시** 끌어내린다 — 못 내는 속도를 계속 명령할 이유가 없다.
SAT_ERR = 0.04           # m/s 실제 보낸 값을 이보다 못 따라오면 못 따라오는 것이다
SAT_WATCH_S = 0.4        # s 이 주기로 판정한다 (가속 여부를 보려면 시간 간격이 필요하다)
SAT_RISE = 0.01          # m/s 이 주기에 이보다 덜 올랐으면 "더는 안 오른다"
SAT_KEEP = 0.95          # 포화면 천장을 실측의 이 비율로 즉시 내린다
SAT_UP = 0.08            # m/s² 천장 상승률 — 회복은 천천히(출력을 올리면 따라 오른다)
V_CEIL_MIN = 0.06        # m/s 천장 하한. 아예 못 가게 되는 것을 막는다

# ── 직진 유지 폐루프 (2026-07-30 신설) ──────────────────────────────────
#  회전 명령이 없을 때(w_cmd≈0) odom yaw 를 기준각으로 잡고 그 각을 지킨다.
#  엔코더 odom 이라 **바퀴 회전수 차이는 그대로 보인다** — 실제로 휘는 만큼
#  yaw 가 움직이므로 폐루프가 성립한다(슬립까지 잡지는 못한다).
#  부호: w +가 좌회전이다. 오른쪽으로 휘면 yaw 가 줄고 err=ref−yaw 가 +가 되어
#  좌회전 보정이 나간다.
YAW_KP = 1.5             # rad/s per rad
YAW_KI = 0.5             # rad/s per rad·s — 좌우 출력차는 상수 편향이라 적분이 필요하다
YAW_I_MAX = 0.20         # 적분 누적 상한 (rad·s)
YAW_W_MAX = 0.35         # rad/s 보정 상한. 조종자가 의도한 직진을 크게 뒤틀지 않게
YAW_HOLD_V = 0.03        # m/s 이보다 빠를 때만 각도를 지킨다 (정지 중엔 안 건다)

# ── 조향 여유 예약 (2026-07-30 실측으로 도출) ────────────────────────────
#  🔴 ⑤ 의 천장이 ⑦ 의 발목을 잡고 있었다. 실측(3.0초·1.30m):
#     SLAM −11.50° vs odom −11.1° → **엔코더는 휨을 정확히 본다**(블라인드 아님).
#     그런데 보정 w 가 상한 0.35 에 붙어 고정된 채 편차가 계속 커졌다.
#     필요량은 0.064 rad/s(외란 −8.8 deg/m × 0.42 m/s)뿐인데 명령의 18% 미만만
#     실현됐다 — 천장이 도달치 바로 아래(0.44)에 앉아서, w 를 주면
#     빠른 쪽 바퀴 목표 0.438 + 0.037 = 0.475 가 도달치(0.42)를 넘어 **포화**했다.
#  → 천장에서 **조향에 쓸 몫을 미리 빼둔다.** 속도를 조금 더 포기하고 조향을 산다.
#  ⚠️ YAW_W_MAX 를 올리는 것은 역효과다 — 예약이 더 필요해져 악화된다.
STEER_RESERVE = 0.5 * TRACK_M * YAW_W_MAX * 1.35    # ≈ 0.049 m/s (35% 여유)


class Teleop(Node):
    def __init__(self, cmd_file):
        super().__init__("teleop_bridge")
        self.cmd_file = cmd_file
        self.scan = None
        self.create_subscription(LaserScan, "/scan", self._scan, qos_profile_sensor_data)
        self.create_subscription(Odometry, "/odom", self._odom, 10)
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.pub_status = self.create_publisher(String, "/teleop/status", 10)
        self.last_reason = ""
        self.stop_frames = 0
        self.patrol_seen = 0.0
        self.v_out = 0.0              # 실제로 내보낸 선속도 — 슬루 리미터의 상태
        self.odom_t = None            # odom 최종 수신 시각
        self.odom_v = 0.0             # odom 실측 선속도
        self.yaw = None               # odom 실측 방위각 (rad)
        self.yaw_ref = None           # 직진 유지 기준각. None 이면 미체결
        self.yaw_i = 0.0              # 직진 유지 적분항
        self.still_t0 = None          # 멈춰 있기 시작한 시각
        self.escape_armed = False     # 정차 후 "제어권 반환" 래치
        self.block_head = None        # 막힌 방향(0=앞, π=뒤). 중립일 때도 계속 본다
        self.v_ceil = V_MAX           # 추정한 도달 가능 속도 천장
        self.sat_t = 0.0              # 포화 판정 최종 시각
        self.v_meas_ref = 0.0         # 그 시점의 실측 속도 (상승 여부 비교용)
        self.create_timer(1.0 / RATE_HZ, self.tick)
        self.create_timer(2.0, self.check_patrol)
        self.get_logger().info(
            f"수동 조종 대기 · 명령파일 {cmd_file} · "
            f"상한 v={V_MAX} w={W_MAX} · 데드맨 {DEADMAN_S}s")

    def _scan(self, m):
        self.scan = m

    def _odom(self, m):
        self.odom_t = time.time()
        self.odom_v = float(m.twist.twist.linear.x)
        q = m.pose.pose.orientation
        self.yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y),
                              1.0 - 2.0 * (q.y * q.y + q.z * q.z))

    def odom_fresh(self, now):
        return self.odom_t is not None and now - self.odom_t < ODOM_STALE_S

    def brake_limit(self, d):
        """장애물이 d[m] 앞에 있을 때 허용할 최대 속도(m/s).

        "반응거리 + 제동거리 ≤ 여유거리" 를 v 로 푼 것이다.

            v·REACT_S  +  v² / (2·A_DEC)  ≤  d − STOP_M

        REACT_S 를 식 안에 품는 것이 핵심이다. 종전 가드는 "STOP_M 안에
        들어오면 v=0" 이라 **데드맨 0.4초 동안 40cm 를 더 가는 만큼을
        계산에 넣지 못했다**(V_MAX 주석이 그 구멍을 인정하고 있었다).

        🔴 여기서 쓰는 A_DEC 은 슬루 리미터의 A_DEC 과 **같은 상수여야 한다.**
        """
        avail = d - STOP_M
        if avail <= 0.0:
            return 0.0
        aT = A_DEC * REACT_S
        return math.sqrt(aT * aT + 2.0 * A_DEC * avail) - aT

    def stopped(self, now):
        """완전 정차 판정 — odom 실측이 있으면 그것을, 없으면 명령값을 쓴다.

        "정차 후에 제어권을 넘긴다"는 요구는 **실제로 섰는지**를 알아야
        성립한다. 명령이 0 인 것과 차가 선 것은 다르다(관성·PID 잔류).
        """
        moving = abs(self.v_out) > 1e-3
        if self.odom_fresh(now):
            moving = moving or abs(self.odom_v) > STOPPED_V
        if moving:
            self.still_t0 = None
            return False
        if self.still_t0 is None:
            self.still_t0 = now
        return (now - self.still_t0) >= STOPPED_S

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
        near = None                   # 진행 방향 최근접 거리 (m)
        v_allow = None                # 제동 곡선이 허용한 상한 (m/s)
        escaping = False              # 탈출 모드로 움직이는 중인가
        turn_cut = False              # 회전 우선 때문에 v 를 깎았나
        brake_cut = False             # 제동 곡선 때문에 v 를 깎았나
        sat_cut = False               # duty 포화 회피 때문에 v 를 깎았나
        yaw_hold = False              # 직진 유지 폐루프가 개입했나
        yaw_err_deg = None            # 그 편차 (deg) — 화면에서 휘는 걸 보게 한다
        reason_soft = False           # reason 이 정보성인가(안전 사유면 덮어쓰지 않는다)
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
            neutral = abs(v) < 1e-3
            is_stopped = self.stopped(now)

            # ① 회전 우선 — 고정 반경이 아니라 **그 순간 낼 수 있는 최선의 회전**.
            #    v_ceil(도달 가능 속도 천장)을 그대로 써서, 빠른 쪽 바퀴 목표(v+half)가
            #    v_ceil 을 넘지 않는 한도까지만 v 를 허용한다. 출력을 올리면 v_ceil 이
            #    올라가 자동으로 타이트해지고, 출력이 약하면 자동으로 완만해진다 —
            #    고정 상수를 안 둔다.
            if abs(w) > 1e-3 and not neutral:
                half = 0.5 * TRACK_M * abs(w)
                cap = max(0.0, self.v_ceil - half)
                if abs(v) > cap:
                    v = math.copysign(cap, v)
                    turn_cut = True

            # 진행 방향 최근접점. 중립일 때도 **직전에 막혔던 쪽**을 계속 본다 —
            # 안 보면 손을 뗀 순간 blocked 가 풀려 탈출 래치를 걸 수 없다.
            head = None
            if not neutral:
                head = 0.0 if v > 0 else math.pi
            elif self.block_head is not None:
                head = self.block_head
            hit = self.cone_min(head) if head is not None else None
            where = ""
            if hit is not None:
                near, bear = hit
                where = "정면" if abs(bear) < 5 else (
                    f"{'좌' if bear > 0 else '우'}{abs(bear):.0f}°")

            # 탈출 래치 — 막혀서 섰다면 조작이 **중립을 한 번 통과한 뒤**에
            # 저속 탈출을 허용한다. 중립 통과를 요구하는 이유: 없으면
            # 0.30m 에서 멈춘 채 버튼을 계속 누르고 있을 때 허용이 열려
            # 8cm/s 로 벽에 계속 파고든다. 손을 뗐다 다시 누르는 것이
            # "제어권을 넘겨받는" 행위다.
            blocked = near is not None and near < STOP_M
            self.block_head = head if blocked else None
            if blocked and neutral and is_stopped:
                self.escape_armed = True
            elif not blocked:
                self.escape_armed = False

            # 운동학 제동 — 충돌하지 않을 속도까지만 허용한다.
            if near is not None:
                v_allow = self.brake_limit(near)
                if blocked and self.escape_armed:
                    v_allow, escaping = ESCAPE_V, True
                if abs(v) > v_allow:
                    v = math.copysign(v_allow, v)
                    brake_cut = True

            # ⑤ 포화 회피 — 도달 가능한 천장을 추정해 그 아래에 머문다.
            #    이게 없으면 duty 상한에 양쪽이 동시에 붙어 조향 권한이 사라진다.
            #    🔴 가속 중에는 못 따라오는 게 정상이다 — 그때 천장을 내리면 출발도
            #    못 한다. 그래서 "못 따라온다" 만으로 판정하지 않고 **실측이 더는
            #    오르지 않는지**까지 본다. 둘이 동시면 그게 포화다.
            if self.odom_fresh(now) and abs(v) > 1e-3:
                if now - self.sat_t >= SAT_WATCH_S:
                    meas = abs(self.odom_v)
                    lagging = abs(self.v_out) - meas > SAT_ERR
                    rising = meas - self.v_meas_ref > SAT_RISE
                    if lagging and not rising:
                        # 더 못 낸다. 천장을 실측 아래로 즉시 끌어내리고,
                        # 조향에 쓸 몫(STEER_RESERVE)까지 빼둔다.
                        self.v_ceil = max(V_CEIL_MIN,
                                          meas * SAT_KEEP - STEER_RESERVE)
                    elif not lagging:
                        self.v_ceil = min(V_MAX,
                                          self.v_ceil + SAT_UP * SAT_WATCH_S)
                    self.sat_t, self.v_meas_ref = now, meas
                if abs(v) > self.v_ceil:
                    v = math.copysign(self.v_ceil, v)
                    sat_cut = True

            if escaping:
                reason = (f"탈출 허용 — {where} {near * 100:.0f}cm · "
                          f"{ESCAPE_V:.2f}m/s 상한")
            elif blocked:
                reason = (f"정차 — {where} {near * 100:.0f}cm · 손을 떼면 탈출 허용"
                          if is_stopped else
                          f"제동 — {where} {near * 100:.0f}cm")
            elif brake_cut:
                reason = (f"제동 곡선 — {where} {near * 100:.0f}cm · "
                          f"v ≤ {v_allow:.2f}m/s")
            elif turn_cut:
                r = abs(v) / abs(w) if abs(w) > 1e-6 else float("inf")
                reason = (f"회전 우선 — v ≤ {abs(v):.2f}m/s "
                          f"(반경 {r:.2f}m · 천장 {self.v_ceil:.2f}m/s)")
                reason_soft = True
            elif sat_cut:
                reason = (f"포화 회피 — 천장 {self.v_ceil:.2f}m/s "
                          f"(실측 {abs(self.odom_v):.2f} · 출력 상한에 걸려 있다)")
                reason_soft = True

        # 슬루 리미터 — 목표까지 가속도 상한 안에서만 움직인다. 부호 전환이
        # 반드시 0 을 통과하므로 후진↔전진 급전환이 직진 감속과 **같은 경로**를
        # 탄다. 이게 울컥임의 해법이다.
        # 비상 경로(비활성·순찰·명령없음)는 슬루하지 않고 즉시 0 이다 —
        # "버튼에서 손을 떼면 선다"는 안전 계약을 지연시켜선 안 된다.
        if hard:
            self.v_out = 0.0
            self.sat_t, self.v_meas_ref = 0.0, 0.0
            self.still_t0 = None
            self.escape_armed = False
            self.block_head = None
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

        # ⑦ 직진 유지 — 회전 명령이 없으면 odom yaw 를 붙잡는다.
        #    좌우 출력차는 시간에 따라 변하는 양이라(§L: 23.8% → 39.1%) 고정
        #    보정계수로는 못 잡는다. 그래서 폐루프여야 하고, 상수 편향을 없애려면
        #    적분항이 필요하다.
        #    조종자가 회전을 명령하면 기준각을 버린다 — 놓아줘야 돌 수 있다.
        if (not hard and coast_a is None and abs(w) < 1e-3
                and abs(v) > YAW_HOLD_V
                and self.yaw is not None and self.odom_fresh(now)):
            if self.yaw_ref is None:
                self.yaw_ref, self.yaw_i = self.yaw, 0.0
            d = self.yaw_ref - self.yaw
            err = math.atan2(math.sin(d), math.cos(d))        # ±π 로 감는다
            self.yaw_i = max(-YAW_I_MAX,
                             min(YAW_I_MAX, self.yaw_i + err / RATE_HZ))
            w = max(-YAW_W_MAX,
                    min(YAW_W_MAX, YAW_KP * err + YAW_KI * self.yaw_i))
            yaw_hold = True
            yaw_err_deg = round(math.degrees(err), 2)
            # 포화 회피·회전 우선은 **상시 참**이라 그냥 두면 직진 유지 메시지를
            # 영구히 가린다(실제로 그랬다). 정보성 사유는 덮어쓰고 천장은 뒤에 붙인다.
            if not reason or reason_soft:
                reason = (f"직진 유지 — 편차 {math.degrees(err):+.1f}° "
                          f"보정 {w:+.2f}rad/s"
                          + (f" · 천장 {self.v_ceil:.2f}m/s" if sat_cut else ""))
        else:
            self.yaw_ref, self.yaw_i = None, 0.0

        if not reason:
            reason = "주행 중" if (abs(v) > 1e-3 or abs(w) > 1e-3) else "정지"

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
              "patrol_running": now - self.patrol_seen < 5.0,
              # 아래는 2026-07-30 신설 — "왜 느려졌는지"를 화면에 보이게 한다
              "near": round(near, 3) if near is not None else None,
              "v_allow": round(v_allow, 3) if v_allow is not None else None,
              "brake": brake_cut, "turn_cut": turn_cut, "escape": escaping,
              "escape_armed": self.escape_armed, "deadman_coast": coast_a is not None,
              "turn_radius": round(abs(v) / abs(w), 3) if abs(w) > 1e-6 else None,
              "a_dec": A_DEC, "react_s": REACT_S,
              "sat_cut": sat_cut, "yaw_hold": yaw_hold, "yaw_err_deg": yaw_err_deg,
              "v_ceil": round(self.v_ceil, 3),
              "odom_v": round(self.odom_v, 3) if self.odom_fresh(now) else None}
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
