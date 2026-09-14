"""Back out along the path just driven when the safety stop wedges the robot.

collision_monitor's immediate_stop polygon is a circle with action_type: stop --
omnidirectional and velocity-independent. Once anything sits inside 0.22 m it
zeroes /cmd_vel/autonomy no matter which way the robot is asked to go, so a
wedged robot cannot drive itself out and Nav2 burns the whole goal timeout
being held in place.

This node watches for that state and retraces the last few metres in reverse.

  detect   /collision_monitor_state reports STOP continuously for
           stuck_grace_sec while the mux is armed in autonomy
  announce publish "escaping" and give the explorer settle_sec to cancel its
           goal -- until Nav2 stops feeding the monitor, the monitor keeps
           publishing zeros onto /cmd_vel/autonomy and we would just be
           fighting it for the mux's last-writer-wins slot
  replay   walk the recorded /cmd_vel history backwards, emitting the inverse
           of each twist
  announce publish "recovered"; the explorer blacklists the goal that led here

Why (-v, -w) in reverse order retraces the path: a differential-drive twist
(v, w) held for dt is a rotation about an ICC at radius v/w. The inverse twist
has (-v)/(-w) = v/w, so it is the same circle, traversed backwards, undoing
exactly dt*w of heading. Applying the inverses newest-first therefore returns
the robot along its own path, open-loop, wheel slip aside.

SAFETY: replaying onto /cmd_vel/autonomy deliberately bypasses immediate_stop
-- that is the whole point, since that polygon is what is holding the robot.
The bypass is bounded: speed caps, a hard replay_max_sec ceiling, abort on
estop or a mode change, and a scan check in the direction of travel so we never
reverse into something behind us. The path being retraced was driveable seconds
earlier, which is what makes this the safest available motion.
"""

import math
from collections import deque

import rclpy
from geometry_msgs.msg import Twist
from nav2_msgs.msg import CollisionMonitorState, Costmap
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import LaserScan
from std_msgs.msg import Bool, Empty, String
from tf2_ros import (Buffer, ConnectivityException, ExtrapolationException,
                     LookupException, TransformListener)

IDLE, SETTLING, REPLAYING, COOLDOWN = "idle", "settling", "replaying", "cooldown"
# [2026-08-08] L2: 되감기가 막히면 "지금 가장 트인 방향으로 곧게" 나간다.
TRANSLATING = "translating"

# base_link -> laser_frame (tf2_echo 실측). 스캔 각도를 base_link 로 옮길 때 쓴다.
# 🔴 라이다가 거의 180° 돌아 달려 있어, 이 보정을 빼면 앞뒤 판정이 뒤집힌다.
LX, LY, LYAW = 0.0550, -0.0051, -3.06639
# 실측 footprint 에서 계산 (docs/차체_footprint_실측_2026-08-07.md)
CIRCUM_RADIUS = 0.328          # 제자리 회전에 필요한 반경
HALF_WIDTH = 0.184             # 통로 판정용 반폭
FRONT_EXTENT = 0.270           # base_link 원점에서 코 끝까지
REAR_EXTENT = 0.155            # base_link 원점에서 뒷면까지


def latched_qos():
    qos = QoSProfile(depth=1)
    qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
    qos.reliability = ReliabilityPolicy.RELIABLE
    return qos


class EscapeRecovery(Node):

    def __init__(self):
        super().__init__("escape_recovery")
        self.declare_parameter("executed_cmd_topic", "/cmd_vel")
        # collision_monitor 가 소유한 /cmd_vel/autonomy 에 같이 쓰면 mux 가
        # 마지막 도착분을 집어 후진과 0 이 번갈아 나간다. 전용 채널을 쓴다.
        self.declare_parameter("cmd_vel_out_topic", "/cmd_vel/escape")
        self.declare_parameter("monitor_state_topic", "/collision_monitor_state")
        # 🔴 [2026-08-08] 위 monitor_state_topic 은 **Humble 에서 동작하지 않는다.**
        #    nav2_collision_monitor 1.1.20 은 `state_topic` 파라미터를 선언조차 하지
        #    않는다(Iron 부터 추가). 그래서 /collision_monitor_state 는 발행자가 0 이고,
        #    "안전정지가 유지됨" 트리거가 **영원히 발동하지 못했다**.
        #    우리 동결은 대부분 감시기발인데 정확히 그 경우만 감지를 못 했다
        #    (실측: 260.3초 동결에 트리거 0회).
        #
        #    대체 수단: 감시기의 **입력과 출력을 비교**한다. 상위가 움직이라고 하는데
        #    (입력 비영) 아무것도 안 나가면(출력 영 또는 무발행) 안전계층이 막고 있는 것이다.
        #    새 토픽도 Nav2 업그레이드도 필요 없다. state_topic 이 언젠가 동작하게 되면
        #    두 경로가 함께 작동한다(서로 다른 변수를 쓰므로 충돌하지 않는다).
        self.declare_parameter("monitor_in_topic", "/cmd_vel/autonomy_raw")
        self.declare_parameter("monitor_out_topic", "/cmd_vel/autonomy")
        # 입력이 비영인데 출력이 이 시간 넘게 잠잠하면 '막혔다'고 본다.
        self.declare_parameter("held_window_sec", 0.6)
        self.declare_parameter("scan_topic", "/scan_safety_body")
        # planner_server 가 시작점을 판정할 때 보는 바로 그 costmap.
        self.declare_parameter("costmap_topic",
                               "/global_costmap/costmap_raw")
        self.declare_parameter("global_frame", "map")
        self.declare_parameter("robot_base_frame", "base_link")
        # 253 = INSCRIBED_INFLATED_OBSTACLE. Node2D::isNodeValid 가
        # 이 값 이상을 충돌로 보고, 그래서 계획이 시작부터 실패한다.
        self.declare_parameter("lethal_cost_threshold", 253)
        # 끼임 판정은 TF 조회 + costmap 인덱싱이라 20Hz 로 돌릴 일이 아니다.
        self.declare_parameter("cost_check_period_sec", 0.25)
        # 시간이 아니라 거리로 보관한다. 끼인 채 오래 서 있어도 진입
        # 경로가 남아야 되감을 수 있다.
        self.declare_parameter("history_distance_m", 1.0)
        self.declare_parameter("history_max_samples", 400)
        # 제자리 회전을 거리로 환산하는 계수 = 윤거/2.
        # esp32_base_node.py 의 track_width_m 0.3260 실측값 기준.
        self.declare_parameter("rotation_radius_m", 0.163)
        self.declare_parameter("stuck_grace_sec", 3.0)
        self.declare_parameter("settle_sec", 1.2)
        self.declare_parameter("replay_max_sec", 6.0)
        self.declare_parameter("max_linear", 0.08)
        self.declare_parameter("max_angular", 0.50)
        self.declare_parameter("motion_epsilon", 0.005)
        self.declare_parameter("travel_abort_m", 0.12)
        self.declare_parameter("cooldown_sec", 15.0)
        # --- L2 병진 탈출 [2026-08-08] ---
        # 성공 판정: 최근접이 이 값 이상이면 제자리 회전이 가능하다.
        self.declare_parameter("rotation_clear_m", CIRCUM_RADIUS + 0.03)
        # [2026-08-09] 회전 여유 게이트. 아래 두 값은 짝이다 — 하나만 바꾸지 말 것.
        #   spin_min_angular    : 이 이상이면 '제자리 회전 중' 으로 본다
        #   rotation_gate_grace : 이만큼 지속돼야 발동 (순간적 방향 전환은 무시)
        # [2026-08-09] 0.15 -> 0.10. 접촉 최심 프레임의 실행 각속도가 -0.140
        # 이었는데 임계 0.15 라 '회전 중' 으로 세지 않아 게이트가 안 걸렸다.
        # [2026-08-10] 0.10 -> 0.01. 순찰 12분 고착의 직접 원인.
        # collision_monitor 의 approach 폴리곤이 회전 0.500 -> 0.042 로 깎았는데
        # 0.042 < 0.10 이라 '회전 중' 으로 세지 않았고, 회전 여유 게이트가
        # 한 번도 안 걸려 탈출이 발동하지 않았다(2,262 샘플 / 12분 / 변위 0.0cm).
        # 🔴 낮춰도 헛발동하지 않는 이유: 이 값은 게이트 3개 중 하나일 뿐이다.
        #    |v|<motion_epsilon · 같은 부호로 grace 이상 지속 ·
        #    _spin_free_angle 이 spin_min_free_deg 미만(=진짜 막힘) 일 때만 발동.
        # 근거: bag 7,115 스캔 전수에서 막은 벽은 앞-왼쪽(base_link +50°, 여유 19mm)
        #    인데 Spin 복구는 12건 전부 반시계(+0.500) 였다 — 막힌 쪽으로만 돌았다.
        #    이 게이트가 걸려야 _spin_free_angle 이 뚫린 부호를 고른다.
        self.declare_parameter("spin_min_angular", 0.01)
        self.declare_parameter("rotation_gate_grace_sec", 1.0)
        # [2026-08-09] 남은 회전 각도가 이보다 작으면 '곧 닿는다' 로 본다.
        # 🔴 거리 임계(rotation_clear_m)로 회전을 통째로 막지 않는다 —
        #    사용자 지침: "꼭 한 바퀴가 아니라 회전 가능한 만큼 회전하면 된다".
        #    외접반경은 가장 먼 모서리 기준이라, 그 모서리가 향하지 않는 쪽으로는
        #    여유가 훨씬 많다. 거리 하나로 재면 그 여유를 통째로 버린다.
        # [2026-08-09] '다가온다' 검사를 볼 여유 상한. 이보다 앞이 넓으면
        # 요동을 위협으로 치지 않는다. 실측: 앞이 1.35 m 비었는데 0.3 m 요동으로
        # 탈출이 중단됐다. 실제 위험은 travel_abort_m 검사와 collision_monitor 담당.
        self.declare_parameter("approach_check_max_free_m", 0.60)
        self.declare_parameter("spin_min_free_deg", 10.0)
        # 이 각도까지만 앞을 본다. 그 이상 돌 수 있으면 더 볼 필요가 없다.
        self.declare_parameter("spin_scan_max_deg", 90.0)
        # 계산 주기. 20Hz 로 매번 돌리면 점 93개 x 60스텝이 CPU 를 먹는다.
        self.declare_parameter("spin_check_period_sec", 0.25)
        self.declare_parameter("translate_speed", 0.05)      # 정상 주행의 절반
        self.declare_parameter("translate_max_m", 0.40)
        self.declare_parameter("translate_max_sec", 20.0)
        self.declare_parameter("scan_stale_sec", 0.3)        # 눈 감고 움직이지 않는다
        self.declare_parameter("max_attempts", 3)            # 넘으면 포기 신호
        self.declare_parameter("publish_rate_hz", 20.0)

        value = lambda key: self.get_parameter(key).value
        self.history_distance_m = float(value("history_distance_m"))
        self.history_max_samples = int(value("history_max_samples"))
        self.rotation_radius_m = float(value("rotation_radius_m"))
        self.stuck_grace_sec = float(value("stuck_grace_sec"))
        self.settle_sec = float(value("settle_sec"))
        self.replay_max_sec = float(value("replay_max_sec"))
        self.max_linear = abs(float(value("max_linear")))
        self.max_angular = abs(float(value("max_angular")))
        self.motion_epsilon = float(value("motion_epsilon"))
        self.travel_abort_m = float(value("travel_abort_m"))
        self.cooldown_sec = float(value("cooldown_sec"))
        self.global_frame = str(value("global_frame"))
        self.robot_base_frame = str(value("robot_base_frame"))
        self.lethal_cost_threshold = int(value("lethal_cost_threshold"))
        self.cost_check_period = float(value("cost_check_period_sec"))
        self.rate = float(value("publish_rate_hz"))
        self.held_window_sec = float(value("held_window_sec"))

        self._history = deque()      # (stamp, linear, angular) actually executed
        self._plan = deque()         # (linear, angular, seconds) still to replay
        # 🔴 위(129행)에 이미 value = lambda key: self.get_parameter(key).value 가 있다.
        #    그 이름을 덮어쓰면 이후 모든 value(...) 호출이 Parameter 객체를 돌려주어
        #    토픽 이름이 깨진다 — 실제로 그렇게 만들어 노드를 크래시 루프에 빠뜨렸다.
        self.rotation_clear_m = float(value("rotation_clear_m"))
        self.spin_min_angular = float(value("spin_min_angular"))
        self.rotation_gate_grace = float(value("rotation_gate_grace_sec"))
        self.approach_check_max_free = float(
            value("approach_check_max_free_m"))
        self.spin_min_free = math.radians(float(value("spin_min_free_deg")))
        self.spin_scan_max = math.radians(float(value("spin_scan_max_deg")))
        self.spin_check_period = float(value("spin_check_period_sec"))
        self._last_spin_check = 0.0
        self._spin_free = None      # 마지막으로 잰 '남은 회전 각도'
        self._spin_sign = 0
        self.translate_speed = float(value("translate_speed"))
        self.translate_max_m = float(value("translate_max_m"))
        self.translate_max_sec = float(value("translate_max_sec"))
        self.scan_stale_sec = float(value("scan_stale_sec"))
        self.max_attempts = int(value("max_attempts"))
        self._state = IDLE
        # 제자리 회전이 시작된 시각. 회전이 아니면 None.
        self._spin_since = None
        # L2 상태
        self._trans_sign = 0.0
        # 최근 여유 측정 버퍼. 단일 프레임 요동(실측 0.95~2.2 m)을 죽인다.
        self._free_window = deque(maxlen=5)
        self._trans_start = None
        self._trans_free0 = None
        self._attempts = 0
        self._phase_started = 0.0
        self._stop_since = None
        # 감시기 출력이 막힌 시점. _stop_since 와 별도로 둔다 — state_topic 이
        # 동작하는 배포판에서 두 경로가 서로를 지우지 않게.
        self._held_since = None
        self._mon_in_nonzero_t = float("-inf")
        self._mon_out_nonzero_t = float("-inf")
        self._lethal_since = None
        self._requested = False
        self._costmap = None
        self._last_cost_check = 0.0
        self._armed = False
        self._estop = True
        self._scan = None

        self._cmd = self.create_publisher(Twist, str(value("cmd_vel_out_topic")), 10)
        self._state_publisher = self.create_publisher(
            String, "/escape/state", latched_qos())
        # 탈출을 포기했음을 상위(사이클 스크립트)에 알린다 -> 지도 폐기 + 재배치(L4)
        self._gaveup_publisher = self.create_publisher(
            String, "/escape/gave_up", latched_qos())
        self.create_subscription(
            Twist, str(value("executed_cmd_topic")), self._on_executed, 10)
        self.create_subscription(
            CollisionMonitorState, str(value("monitor_state_topic")),
            self._on_monitor, 10)
        self.create_subscription(
            LaserScan, str(value("scan_topic")), self._on_scan, 10)
        # 감시기 입력·출력 (state_topic 대체 감지)
        self.create_subscription(
            Twist, str(value("monitor_in_topic")), self._on_monitor_in, 10)
        self.create_subscription(
            Twist, str(value("monitor_out_topic")), self._on_monitor_out, 10)
        self.create_subscription(
            Costmap, str(value("costmap_topic")), self._on_costmap, 1)
        self.create_subscription(
            Empty, "/escape/request", self._on_request, 10)
        self._buffer = Buffer()
        self._listener = TransformListener(self._buffer, self)
        # control_state_bridge 는 마지막 상태를 래치해 보낸다 — VOLATILE 로 받으면
        # 재시작 직후 arm 상태를 놓쳐 한참 disarmed 로 오해한다 (S15P11E101-801).
        self.create_subscription(
            String, "/bbiyong/control_mode", self._on_mode, latched_qos())
        self.create_subscription(
            Bool, "/bbiyong/estop", self._on_estop, latched_qos())
        self.create_timer(1.0 / self.rate, self._tick)
        self._announce(IDLE)
        self.get_logger().info(
            f"escape recovery armed: wedge held {self.stuck_grace_sec:.1f}s "
            f"triggers a reverse replay of up to {self.replay_max_sec:.1f}s "
            f"at <={self.max_linear:.2f} m/s, retracing the last "
            f"{self.history_distance_m:.2f} m of pose travel "
            f"(rotation counted at r={self.rotation_radius_m:.3f} m)")

    def _now(self):
        return self.get_clock().now().nanoseconds / 1e9

    def _announce(self, state, detail=""):
        self._state_publisher.publish(String(data=state + detail))

    def _on_mode(self, message):
        self._armed = message.data.strip().lower() == "autonomy"

    def _on_estop(self, message):
        self._estop = bool(message.data)

    def _on_scan(self, message):
        self._scan = message

    def _on_executed(self, message):
        # REPLAYING 만 막으면 된다 — 우리가 낸 후진 명령을 되감기 이력에
        # 넣으면 자기 자신을 무한히 되감는다. COOLDOWN·SETTLING 까지
        # 막았던 탓에 탈출 시도 뒤 15초간 귀가 먹었다.
        if self._state == REPLAYING:
            return
        # 정지 버튼으로 선 것은 되감고 싶은 움직임이 아니다.
        if self._estop or not self._armed:
            return
        linear, angular = message.linear.x, message.angular.z
        # [2026-08-09] 제자리 회전이 얼마나 이어졌는지 센다 (회전 여유 게이트용).
        # 🔴 **실행된** 명령(/cmd_vel)이라야 한다. Nav2 의 희망(/cmd_vel_nav)을
        #    세면 안전 계층이 이미 자른 회전까지 세어 헛발동한다 — 2026-08-08
        #    분석이 정확히 그 두 토픽을 혼동해 "w=+0.420 으로 회전 중이었다"고
        #    잘못 적었고, 실제 실행값은 w=0 이었다.
        if (abs(linear) < self.motion_epsilon
                and abs(angular) >= self.spin_min_angular):
            sign = 1 if angular > 0 else -1
            # 방향이 바뀌면 처음부터 다시 센다 — 반대로 도는 것은 대개
            # 여유가 있는 쪽이라, 이전 방향의 누적을 물려주면 헛발동한다.
            if self._spin_since is None or sign != self._spin_sign:
                self._spin_since = self._now()
                self._spin_free = None
            self._spin_sign = sign
        else:
            self._spin_since = None
            self._spin_sign = 0
        moving = (abs(linear) >= self.motion_epsilon
                  or abs(angular) >= self.motion_epsilon)
        # 정지 구간은 한 항목으로 접는다. 20Hz 로 0 을 계속 쌓으면 몇 초만
        # 서 있어도 되감을 움직임이 버퍼 밖으로 밀려난다 — 이것이 11:28 에
        # "no recent motion to undo" 가 나온 이유다. 접어 두면 마지막
        # 움직임의 구간 길이(다음 항목까지의 시간)도 그대로 보존된다.
        if not moving and self._history and not self._history[-1][3]:
            return
        self._history.append((self._now(), linear, angular, moving))
        self._prune_history()

    def _pose_length(self, linear, angular, duration):
        """How far the wheels rolled: translation and rotation on one ruler."""
        return (abs(linear)
                + self.rotation_radius_m * abs(angular)) * duration

    def _prune_history(self):
        """Keep the last history_distance_m of pose travel, oldest dropped first."""
        travelled = 0.0
        cutoff = 0
        for index in range(len(self._history) - 1, 0, -1):
            duration = self._history[index][0] - self._history[index - 1][0]
            if 0.0 < duration <= 1.0:
                travelled += self._pose_length(
                    self._history[index - 1][1],
                    self._history[index - 1][2], duration)
            if travelled >= self.history_distance_m:
                cutoff = index - 1
                break
        for _ in range(cutoff):
            self._history.popleft()
        # 아주 느리게 오래 움직인 경우의 절대 상한.
        while len(self._history) > self.history_max_samples:
            self._history.popleft()

    def _on_monitor_in(self, message):
        """감시기 입력. 상위(Nav2)가 움직이라고 하는 중인지 기록한다."""
        if (abs(message.linear.x) >= self.motion_epsilon
                or abs(message.angular.z) >= self.motion_epsilon):
            self._mon_in_nonzero_t = self._now()

    def _on_monitor_out(self, message):
        """감시기 출력. 실제로 통과한 명령이 있는지 기록한다."""
        if (abs(message.linear.x) >= self.motion_epsilon
                or abs(message.angular.z) >= self.motion_epsilon):
            self._mon_out_nonzero_t = self._now()

    def _update_held_stop(self, now):
        """입력은 살아 있는데 출력이 죽어 있으면 안전계층이 막고 있는 것이다.

        stop_pub_timeout 을 넘기면 collision_monitor 는 발행 자체를 멈춘다(설계상).
        그래서 '출력이 0' 뿐 아니라 '출력이 아예 없음'도 같은 신호로 봐야 한다 —
        마지막 비영 출력 시각만 보면 두 경우가 자연히 하나로 처리된다.
        """
        wants = (now - self._mon_in_nonzero_t) <= self.held_window_sec
        passing = (now - self._mon_out_nonzero_t) <= self.held_window_sec
        if wants and not passing and self._armed and not self._estop:
            if self._held_since is None:
                self._held_since = now
        else:
            self._held_since = None

    def _on_monitor(self, message):
        if message.action_type == CollisionMonitorState.STOP:
            if self._stop_since is None:
                self._stop_since = self._now()
        else:
            self._stop_since = None

    def _on_costmap(self, message):
        self._costmap = message

    def _on_request(self, message):
        self._requested = True
        self.get_logger().warning("Escape requested externally")

    def _robot_cost(self):
        """Cost under the robot in the planner's costmap, or None."""
        grid = self._costmap
        if grid is None:
            return None
        try:
            found = self._buffer.lookup_transform(
                self.global_frame, self.robot_base_frame, rclpy.time.Time())
        except (LookupException, ConnectivityException,
                ExtrapolationException):
            return None
        meta = grid.metadata
        column = int((found.transform.translation.x
                      - meta.origin.position.x) / meta.resolution)
        row = int((found.transform.translation.y
                   - meta.origin.position.y) / meta.resolution)
        if not (0 <= column < meta.size_x and 0 <= row < meta.size_y):
            return None
        return grid.data[row * meta.size_x + column]

    def _wedge_reason(self, now):
        """Why we should back out, or None. Any one trigger is enough."""
        if self._requested:
            return "external request"
        # 4Hz 로도 stuck_grace_sec(3s) 안에 12표본이 들어온다.
        cost = None
        if now - self._last_cost_check >= self.cost_check_period:
            self._last_cost_check = now
            cost = self._robot_cost()
            if cost is not None and cost >= self.lethal_cost_threshold:
                if self._lethal_since is None:
                    self._lethal_since = now
            else:
                self._lethal_since = None
        if (self._stop_since is not None
                and now - self._stop_since >= self.stuck_grace_sec):
            return "safety stop held"
        if (self._held_since is not None
                and now - self._held_since >= self.stuck_grace_sec):
            return "safety layer held the command (input alive, output dead)"
        if (self._lethal_since is not None
                and now - self._lethal_since >= self.stuck_grace_sec):
            return f"standing in lethal space (cost {cost})"
        # [2026-08-09] 회전 여유 게이트 — 끼인 뒤가 아니라 **끼이기 전에** 잡는다.
        #
        # 위 조건들은 전부 사후적이다(안전정지가 3초 유지됐다, lethal 위에 서
        # 있다...). 그런데 2026-08-08 접촉 2건은 **미리 알 수 있었다**:
        # 제자리 회전을 명령받았는데 최근접 장애물이 외접반경(0.328)보다
        # 가까우면 그 회전은 반드시 차체를 스친다.
        # 실측(rosbag 7개 재분석): 접촉 순간 최근접 반경 0.22~0.31 m.
        # ±34° 에 몰린 것은 footprint 앞 모서리 방위 atan2(0.182,0.270)=34° 다.
        #
        # 🔴 회전 중일 때만 본다. 직진 중에는 폭이 좁아도 지나갈 수 있어,
        #    같은 기준을 들이대면 멀쩡한 통로 주행을 통째로 막는다.
        if (self._spin_since is not None
                and now - self._spin_since >= self.rotation_gate_grace
                and self._spin_sign != 0):
            if now - self._last_spin_check >= self.spin_check_period:
                self._last_spin_check = now
                self._spin_free = self._spin_free_angle(self._spin_sign)
            if (self._spin_free is not None
                    and self._spin_free < self.spin_min_free):
                return ("only %.0f deg of rotation left before contact "
                        "(need %.0f deg)"
                        % (math.degrees(self._spin_free),
                           math.degrees(self.spin_min_free)))
        return None

    def _scan_points(self):
        """스캔을 base_link (x, y) 로 옮겨 돌려준다.

        🔴 [2026-08-08] 마운트 회전(LYAW)을 반드시 적용해야 한다. 라이다가 거의
        180° 돌아 달려 있어, 빼먹으면 앞뒤 판정이 **정반대**가 된다. 실제로
        `_blocked_ahead` 가 그 상태였고, 후진하면서 전방을 검사하고 있었다.
        """
        scan = self._scan
        if scan is None:
            return []
        points = []
        for index, distance in enumerate(scan.ranges):
            if not math.isfinite(distance):
                continue
            if not (scan.range_min < distance < scan.range_max):
                continue
            angle = scan.angle_min + index * scan.angle_increment + LYAW
            points.append((LX + distance * math.cos(angle),
                           LY + distance * math.sin(angle)))
        return points

    def _foot_radius(self, phi):
        """차체 중심에서 방위 phi 의 footprint 경계까지 거리 (직사각형)."""
        c, s = math.cos(phi), math.sin(phi)
        along = FRONT_EXTENT if c >= 0.0 else REAR_EXTENT
        rx = along / abs(c) if abs(c) > 1e-9 else 1e9
        ry = HALF_WIDTH / abs(s) if abs(s) > 1e-9 else 1e9
        return min(rx, ry)

    def _spin_free_angle(self, sign):
        """sign 방향으로 몇 rad 더 돌 수 있나. 닿을 일이 없으면 spin_scan_max.

        [2026-08-09] 회전을 금지하는 대신 **얼마나 돌 수 있는지**를 잰다.
        로봇을 Δ 만큼 돌리면 고정 방위 θ 의 점이 보는 경계 반경은 R(θ − sign·Δ) 다.
        따라서 접촉 조건은 R(θ − sign·Δ) >= r. Δ 를 키우며 첫 접촉을 찾는다.

        외접반경보다 먼 점은 아무리 돌려도 안 닿으므로 먼저 걸러낸다 —
        실측에서 377점 중 93점만 남았다(계산량을 지배하는 것이 이 필터다).
        """
        near = []
        for x, y in self._scan_points():
            r = math.hypot(x, y)
            if r > CIRCUM_RADIUS:
                continue
            near.append((math.atan2(y, x), r))
        if not near:
            return self.spin_scan_max
        step = math.radians(2.0)
        delta = 0.0
        while delta <= self.spin_scan_max:
            for th, r in near:
                if self._foot_radius(th - sign * delta) >= r:
                    return delta
            delta += step
        return self.spin_scan_max

    def _nearest_obstacle(self):
        """base_link 원점에서 가장 가까운 점까지의 거리. 성공 판정의 근거다."""
        points = self._scan_points()
        if not points:
            return None
        return min(math.hypot(x, y) for x, y in points)

    def _free_distance(self, sign):
        """sign(+1 전 / -1 후) 방향으로 **차체 표면부터** 갈 수 있는 거리.

        🔴 원점이 아니라 표면 기준이어야 한다. 이 값은 travel_abort_m(표면 기준
        여유)과 비교되고, 병진 탈출의 이동 가능 거리로도 쓰인다. 원점 기준으로
        재면 뒤쪽은 15.5 cm, 앞쪽은 27 cm 를 실제보다 여유 있게 본다 —
        collision_monitor 를 우회하는 경로라 그대로 충돌로 이어진다.
        """
        extent = FRONT_EXTENT if sign > 0 else REAR_EXTENT
        best = 10.0
        for x, y in self._scan_points():
            if abs(y) > HALF_WIDTH:          # 통로 밖은 무시
                continue
            along = x * sign - extent        # 차체 표면 기준으로 옮긴다
            if along <= -extent:             # 진행 방향 반대편
                continue
            best = min(best, along)
        return max(best, 0.0)

    def _free_smoothed(self, sign):
        """최근 5프레임 최솟값. 요동에 강하고, 최솟값이라 보수적이다.

        원시 `_free_distance` 는 통로 경계를 넘나드는 점 때문에 프레임마다
        크게 튄다(실측 0.95 <-> 2.2 m). 그대로 쓰면 '무언가 접근' 오판으로
        멀쩡한 탈출이 매번 중단된다.
        """
        self._free_window.append(self._free_distance(sign))
        return min(self._free_window)

    def _scan_fresh(self):
        scan = self._scan
        if scan is None:
            return False
        stamp = scan.header.stamp.sec + scan.header.stamp.nanosec * 1e-9
        return abs(self._now() - stamp) <= self.scan_stale_sec

    def _blocked_ahead(self, linear):
        """진행 방향 travel_abort_m 안에 무언가 있는가 (base_link 기준)."""
        if abs(linear) < self.motion_epsilon:
            return False
        sign = 1.0 if linear > 0 else -1.0
        return self._free_distance(sign) < self.travel_abort_m

    def _build_plan(self):
        """Inverse twists, newest first, capped at replay_max_sec of motion."""
        plan = deque()
        budget = self.replay_max_sec
        samples = list(self._history)
        for index in range(len(samples) - 1, 0, -1):
            # 어떤 명령이 실렸던 구간은 그 명령이 도착한 시각부터 다음 명령까지다.
            duration = samples[index][0] - samples[index - 1][0]
            _, linear, angular, _ = samples[index - 1]
            if duration <= 0.0 or duration > 1.0:
                continue
            if (abs(linear) < self.motion_epsilon
                    and abs(angular) < self.motion_epsilon):
                continue
            # v 와 w 를 같은 비율로 줄이고 그만큼 오래 실행해야 궤적 모양이 보존된다.
            scale = 1.0
            if abs(linear) > self.max_linear:
                scale = min(scale, self.max_linear / abs(linear))
            if abs(angular) > self.max_angular:
                scale = min(scale, self.max_angular / abs(angular))
            duration /= scale
            if duration > budget:
                duration = budget
            plan.append((-linear * scale, -angular * scale, duration))
            budget -= duration
            if budget <= 0.0:
                break
        return plan

    def _finish(self, state, detail="", cooldown=True):
        self._cmd.publish(Twist())
        self._plan.clear()
        if state == "recovered":
            # 실제로 되감았으니 그 구간은 이미 소비됐다.
            self._history.clear()
        self._stop_since = None
        self._held_since = None
        self._lethal_since = None
        self._requested = False
        # 쿨다운은 방금 시도한 탈출이 곧바로 재발동하는 것을 막기 위한 것이다.
        # 외부에서 무장을 푼 것은 실패한 시도가 아니므로, 재무장 즉시 다시
        # 판단할 수 있어야 한다.
        self._state = COOLDOWN if cooldown else IDLE
        self._phase_started = self._now()
        self._announce(state, detail)

    def _begin_translate(self, now, near):
        """L2 시작 — 지금 가장 트인 방향(전/후)을 고른다. 회전은 하지 않는다."""
        forward = self._free_distance(1.0)
        backward = self._free_distance(-1.0)
        sign = 1.0 if forward >= backward else -1.0
        free = max(forward, backward)
        # 갈 곳이 없으면 L2 도 무의미하다 -> 포기(L5 는 상위가 판단)
        if free < self.travel_abort_m + 0.05:
            self._give_up("nowhere to go (fwd %.2f / back %.2f m)"
                          % (forward, backward))
            return
        self._trans_sign = sign
        self._trans_start = None          # 첫 tick 에서 odom 기준점을 잡는다
        self._free_window.clear()
        self._trans_free0 = free
        self._state = TRANSLATING
        self._phase_started = now
        self._announce("escaping", ":translate")
        self.get_logger().warning(
            "Straight-line escape %s: free %.2f m, nearest %s m, "
            "target >= %.3f m"
            % ("forward" if sign > 0 else "backward", free,
               "%.3f" % near if near is not None else "?",
               self.rotation_clear_m))

    def _give_up(self, why):
        """세 번 실패했거나 갈 곳이 없다. 상위가 지도 폐기 + 재배치를 하도록 알린다."""
        self._cmd.publish(Twist())
        self._attempts = 0
        self._gaveup_publisher.publish(String(data=why))
        self._finish("gave_up", ":" + why)
        self.get_logger().error("Escape gave up: %s" % why)

    def _tick_translate(self, now):
        if not self._scan_fresh():
            self._cmd.publish(Twist())
            return                        # 눈 감고 움직이지 않는다. 다음 주기에 재시도.
        near = self._nearest_obstacle()
        if near is not None and near >= self.rotation_clear_m:
            self._attempts = 0
            self._finish("recovered", ":translate")
            self.get_logger().info(
                "Straight-line escape succeeded; nearest %.3f m "
                "(rotation possible)" % near)
            return
        free = self._free_smoothed(self._trans_sign)
        if free < self.travel_abort_m:
            self._attempt_failed("blocked ahead (%.2f m)" % free, now)
            return
        travelled = self.translate_speed * (now - self._phase_started)
        # [2026-08-08] 전진하면 앞쪽 여유는 **당연히** 이동한 만큼 줄어든다.
        # 처음 값과 비교하면 정상 주행을 "벽이 다가온다" 로 오판해 5 cm 만에 멈춘다
        # (탈출에는 0.25 m 가 필요하므로 영원히 성공할 수 없었다).
        # 비교 대상은 '이동한 만큼 줄어든 기대값' 이다.
        # 임계 0.15 m 는 스캔 잡음 여유다 — 실측에서 여유가 프레임마다 0.95~2.2 m 로
        # 흔들렸다. 잡음으로 멀쩡한 탈출을 끊는 것이 탈출 실패보다 나쁘다.
        # [2026-08-09] 🔴 여유가 넓을 때는 이 검사를 아예 보지 않는다.
        # 실측: free 1.35 m 로 충분한데 "something approaching (expected 1.65,
        # got 1.35)" 로 탈출이 죽었다. 그때 이동량은 2 cm 뿐이었고, 하락의 정체는
        # 살짝 돌면서 박스 모서리가 통로 판정 폭(|y|<=0.184) 안에 들어온 것이었다.
        # _free_smoothed 가 5프레임 최솟값이라 이런 순간 하락을 그대로 집는다.
        # 이 검사는 '무언가 다가온다' 를 잡으려는 것인데, 앞이 넓으면 위협이 아니다.
        if (self._trans_free0 is not None
                and free < self.approach_check_max_free):
            expected_free = self._trans_free0 - travelled
            if free < expected_free - 0.15:
                self._attempt_failed(
                    "something approaching (expected %.2f, got %.2f m)"
                    % (expected_free, free), now)
                return
        if now - self._phase_started >= self.translate_max_sec:
            self._attempt_failed("timeout", now)
            return
        if travelled >= self.translate_max_m:
            self._attempt_failed("travelled %.2f m without clearance" % travelled,
                                 now)
            return
        command = Twist()
        command.linear.x = self.translate_speed * self._trans_sign
        self._cmd.publish(command)

    def _attempt_failed(self, why, now):
        self._attempts += 1
        if self._attempts >= self.max_attempts:
            self._give_up("%s (attempt %d)" % (why, self._attempts))
            return
        self._finish("aborted", ":" + why)
        self.get_logger().warning(
            "Straight-line escape failed: %s (attempt %d/%d)"
            % (why, self._attempts, self.max_attempts))

    def _tick(self):
        now = self._now()
        self._update_held_stop(now)

        if self._state != IDLE:
            # 탈출 중에 우리가 내는 명령까지 '제자리 회전' 으로 세면 자기 자신을
            # 다시 발동시킨다. IDLE 이 아닐 때는 카운터를 죽여 둔다.
            self._spin_since = None
            self._spin_sign = 0

        if self._state == COOLDOWN:
            if now - self._phase_started >= self.cooldown_sec:
                self._state = IDLE
                self._announce(IDLE)
            return

        if self._state == IDLE:
            if self._estop or not self._armed:
                self._lethal_since = None
                self._requested = False
                return
            reason = self._wedge_reason(now)
            if reason is None:
                return
            self._plan = self._build_plan()
            if not self._plan:
                # [2026-08-08] 되감을 이력이 없어도 포기하지 않는다.
                # 지금 트인 방향으로 곧게 나가는 것(L2)은 이력과 무관하게 가능하다.
                self.get_logger().warning(
                    f"Wedged ({reason}); no motion to undo -- trying "
                    "straight-line escape")
                self._begin_translate(now, self._nearest_obstacle())
                return
            undo = sum(entry[2] for entry in self._plan)
            self.get_logger().warning(
                f"Wedged ({reason}) -- backing out over {undo:.1f}s "
                f"of recorded motion")
            self._state = SETTLING
            self._phase_started = now
            self._announce("escaping")
            return

        if self._estop or not self._armed:
            self._finish("aborted", ":disarmed", cooldown=False)
            self.get_logger().warning("Escape aborted: control was disarmed")
            return

        if self._state == TRANSLATING:
            self._tick_translate(now)
            return

        if self._state == SETTLING:
            # Nav2 가 조용해질 때까지 기다린다 — 그 전에는 collision_monitor 가
            # /cmd_vel/autonomy 로 0 을 계속 쏘아 서로 덮어쓴다.
            if now - self._phase_started >= self.settle_sec:
                self._state = REPLAYING
                self._phase_started = now
            return

        if now - self._phase_started >= self.replay_max_sec or not self._plan:
            # [2026-08-08] 시간이 다 됐다고 복구된 게 아니다. **회전이 되는지 본다.**
            # 이 검증이 없어서 "recovered" 를 선언하자마자 다시 끼는 일이 있었다.
            near = self._nearest_obstacle()
            if near is not None and near >= self.rotation_clear_m:
                self._finish("recovered", ":replay")
                self.get_logger().info(
                    f"Escape complete by replay; nearest {near:.3f} m "
                    f">= {self.rotation_clear_m:.3f} m (rotation possible)")
                return
            self._begin_translate(now, near)
            return

        linear, angular, remaining = self._plan[0]
        if self._blocked_ahead(linear):
            # [2026-08-08] 되감기 방향이 막혔다고 포기하지 않는다.
            # 그건 오히려 **다른 방향을 찾아야 할 상황**이다.
            # 실측: 순찰 중 이 자리에서 4번 발동해 4번 다 여기서 끝났고
            # (`Escape aborted: obstacle within 0.12 m`), 로봇은 최근접 0.185 m 에서
            # 완전히 멈춘 채 Nav2 만 계속 x=0.07 을 내고 있었다.
            # L2 는 지금 스캔에서 가장 트인 방향을 고르므로, 되감기 쪽이 막혀도
            # 반대쪽이 열려 있으면 빠져나온다.
            self.get_logger().warning(
                "Replay blocked (obstacle within "
                f"{self.travel_abort_m:.2f} m backwards) -- trying straight-line "
                "escape in the freest direction instead")
            self._plan.clear()
            self._begin_translate(now, self._nearest_obstacle())
            return
        step = 1.0 / self.rate
        if remaining <= step:
            self._plan.popleft()
        else:
            self._plan[0] = (linear, angular, remaining - step)
        command = Twist()
        command.linear.x = linear
        command.angular.z = angular
        self._cmd.publish(command)


def main(args=None):
    rclpy.init(args=args)
    node = EscapeRecovery()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if rclpy.ok(context=node.context):
                node._cmd.publish(Twist())
        except Exception:
            pass
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
