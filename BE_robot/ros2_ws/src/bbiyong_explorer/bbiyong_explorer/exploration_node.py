"""ROS 2 node that sends frontier goals to Nav2."""

from __future__ import annotations

import time

import fcntl
import os
from dataclasses import dataclass
from math import atan2, ceil, cos, hypot, sin
from time import monotonic

import rclpy
from action_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose
from nav_msgs.msg import OccupancyGrid, Odometry
from rclpy.action import ActionClient
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.duration import Duration
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

from bbiyong_base.qos import CONTROL_STATE_QOS
from rclpy.time import Time
from std_msgs.msg import Bool, String
from std_srvs.srv import Empty
from tf2_ros import Buffer, TransformException, TransformListener

from .frontier import (
    GridSpec,
    Point,
    detect_frontier_clusters,
    frontier_heading,
    loop_is_closed,
    perimeter_heading,
    project_wall_standoff_cluster,
    select_frontier,
    select_perimeter_frontier,
    wall_signature,
)


@dataclass
class BlacklistedGoal:
    point: Point
    expires_at: float


class FrontierExplorer(Node):
    """Choose reachable map frontiers and delegate motion to Nav2."""

    def __init__(self) -> None:
        super().__init__("frontier_explorer")

        # A second exploration launch creates another NavigateToPose client,
        # controller, collision monitor, and command mux with the same names.
        # Both explorers then preempt one another's goals every few seconds.
        # Hold a process-wide lock for this node's lifetime so only one source
        # is ever allowed to command autonomous frontier goals.
        self._instance_lock = open(
            "/tmp/bbiyong_frontier_explorer.lock",
            "a+",
            encoding="utf-8",
        )
        try:
            fcntl.flock(
                self._instance_lock.fileno(),
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
        except BlockingIOError as error:
            self._instance_lock.close()
            raise RuntimeError(
                "another frontier_explorer is already running; "
                "stop the existing exploration launch first"
            ) from error
        self._instance_lock.seek(0)
        self._instance_lock.truncate()
        self._instance_lock.write(f"{os.getpid()}\n")
        self._instance_lock.flush()

        self.declare_parameter("map_topic", "/map")
        self.declare_parameter("navigate_to_pose_action", "/navigate_to_pose")
        self.declare_parameter("global_frame", "map")
        self.declare_parameter("robot_frame", "base_link")
        self.declare_parameter("planning_period_sec", 0.5)
        self.declare_parameter("goal_timeout_sec", 90.0)
        self.declare_parameter("goal_timeout_base_sec", 30.0)
        self.declare_parameter("goal_timeout_per_meter_sec", 20.0)
        self.declare_parameter("max_goal_timeout_sec", 300.0)
        self.declare_parameter("goal_response_timeout_sec", 5.0)
        self.declare_parameter("cancel_grace_sec", 3.0)
        self.declare_parameter("server_wait_timeout_sec", 2.0)
        self.declare_parameter("startup_grace_sec", 3.0)
        self.declare_parameter("completion_stable_sec", 15.0)
        # 로봇이 이미 서 있는 자리를 목표로 내면 Nav2 가 즉시 성공을 돌려주고
        # 같은 점이 다시 뽑혀 무한히 맴돈다. 그보다 가까운 목표는 보내지 않는다.
        self.declare_parameter("min_goal_progress_m", 0.15)
        self.declare_parameter("stalled_goal_limit", 3)
        self.declare_parameter("minimum_known_free_cells", 100)
        self.declare_parameter("free_threshold", 20)
        self.declare_parameter("min_cluster_size", 5)
        self.declare_parameter("occupied_threshold", 65)
        self.declare_parameter("analysis_resolution_m", 0.05)
        self.declare_parameter("min_obstacle_clearance_m", 0.30)
        self.declare_parameter("goal_standoff_m", 0.0)
        # [2026-08-08] 갈 곳을 못 찾은 채 이 시간이 지나면 탐사를 끝낸다.
        # 시연에서 30초 넘게 멈춰 있는 것은 허용되지 않는다는 사용자 지침.
        self.declare_parameter("no_progress_timeout_sec", 30.0)
        self.declare_parameter("require_known_goal_clearance", False)
        self.declare_parameter("openness_radius_m", 1.0)
        self.declare_parameter("prefer_exterior_frontiers", True)
        self.declare_parameter("min_frontier_distance", 0.5)
        self.declare_parameter("information_gain_weight", 2.0)
        self.declare_parameter("distance_weight", 1.0)
        self.declare_parameter("open_space_weight", 2.0)
        self.declare_parameter("heading_change_weight", 1.0)
        self.declare_parameter("blacklist_radius", 0.6)
        self.declare_parameter("blacklist_ttl_sec", 120.0)
        # 도달 실패한 벽을 영구 폐기하지 않는다. 한 자세에서 못 간 벽이
        # 2m 옆에서는 갈 수 있다. 0 이면 영구(종전 동작).
        self.declare_parameter("discarded_wall_ttl_sec", 45.0)
        # 같은 벽이 이 횟수만큼 실패하면 만료시키지 않고 영구 폐기한다.
        # TTL 만 두면 도달 불가능한 벽이 만료 → 재획득 → 실패를 무한 반복해
        # 탐색이 완료 판정에 도달하지 못한다(2026-08-07 01:07 실측, 66초 주기).
        self.declare_parameter("discarded_wall_failure_limit", 3)
        self.declare_parameter("exploration_mode", "perimeter_then_cleanup")
        self.declare_parameter("wall_side", "left")
        self.declare_parameter("target_wall_distance_m", 0.5)
        self.declare_parameter("wall_distance_tolerance_m", 0.2)
        self.declare_parameter("wall_search_radius_m", 1.2)
        self.declare_parameter("minimum_structural_wall_length_m", 1.0)
        self.declare_parameter("wall_persistence_updates", 2)
        self.declare_parameter("perimeter_heading_weight", 2.5)
        self.declare_parameter("wall_lost_updates", 3)
        self.declare_parameter("max_acquire_frontier_goals", 3)
        self.declare_parameter("minimum_loop_travel_m", 3.0)
        self.declare_parameter("loop_position_tolerance_m", 0.5)
        self.declare_parameter("loop_heading_tolerance_rad", 0.52)
        self.declare_parameter("completed_wall_exclusion_radius_m", 0.6)
        self.declare_parameter("completed_wall_sample_spacing_m", 0.2)
        self.declare_parameter("return_to_start_tolerance_m", 0.25)
        self.declare_parameter("return_to_start_heading_tolerance_rad", 0.052)

        self._global_frame = str(self.get_parameter("global_frame").value)
        self._robot_frame = str(self.get_parameter("robot_frame").value)
        self._map: OccupancyGrid | None = None
        self._goal_pending = False
        self._goal_handle = None
        # 마지막으로 '의미 있는 진전' 이 있었던 시각 (목표 발행 또는 목표 실행 중)
        self._last_progress_at = None
        self._goal_response_future = None
        self._goal_point: Point | None = None
        self._goal_started_at = 0.0
        self._goal_timeout_sec = float(self.get_parameter("goal_timeout_sec").value)
        self._cancel_requested = False
        self._safety_halt = False
        self._goal_sequence = 0
        self._blacklist: list[BlacklistedGoal] = []
        self._started_at = monotonic()
        self._no_frontier_since: float | None = None
        self._completed = False
        self._control_mode = "disabled"
        self._estop = True
        exploration_mode = str(self.get_parameter("exploration_mode").value)
        self._exploration_mode = exploration_mode
        self._phase = (
            "acquire_boundary"
            if exploration_mode in (
                "perimeter_then_cleanup",
                "all_obstacles_then_return",
            )
            else "cleanup"
        )
        self._latest_odom_position: Point | None = None
        self._last_odom_position: Point | None = None
        self._perimeter_start_position: Point | None = None
        self._perimeter_start_heading = 0.0
        self._perimeter_travel_m = 0.0
        self._last_wall_point: Point | None = None
        self._wall_observations: dict[tuple[int, int], tuple[int, int]] = {}
        self._analysis_epoch = 0
        self._wall_lost_count = 0
        self._acquire_goal_count = 0
        self._start_pose: tuple[Point, float] | None = None
        self._active_wall_points: list[Point] = []
        self._completed_wall_points: list[Point] = []
        self._discarded_walls: list[BlacklistedGoal] = []
        # 벽 위치별 누적 실패 횟수. (지점, 횟수) — 근접한 것은 같은 벽으로 센다.
        self._wall_failures: list[tuple[Point, int]] = []
        # 연속으로 '제자리 목표' 가 나온 횟수. 한도를 넘으면 그 벽을 접는다.
        self._stalled_goals = 0
        # escape_recovery 가 immediate_stop 에 끼인 로봇을 후진으로 빼내는 중.
        self._escaping = False
        self._escape_cancel = False
        self._goal_kind = "frontier"
        self._goal_wall_point: Point | None = None
        self._discard_wall_on_failure = False

        map_qos = QoSProfile(depth=1)
        map_qos.reliability = ReliabilityPolicy.RELIABLE
        map_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        status_qos = CONTROL_STATE_QOS

        self.create_subscription(
            OccupancyGrid,
            str(self.get_parameter("map_topic").value),
            self._on_map,
            map_qos,
        )
        self.create_subscription(Odometry, "/odom", self._on_odom, 20)
        control_callbacks = MutuallyExclusiveCallbackGroup()
        # (S15P11E101-801) 발행자(control_state_bridge.py)는 TRANSIENT_LOCAL 로 마지막
        # 상태를 래치해 보낸다 — 늦게 붙는 구독자도 다음 주기(10Hz)까지 기다리지 않고
        # 즉시 현재 arm/estop 상태를 받아야 한다. 여기서 순정수(10)를 쓰면 기본 QoS인
        # VOLATILE 이 되어 래치된 값을 못 받고, 매핑마다 새로 뜨는 이 노드가 매번
        # "disabled/estop=True" 초기값에 갇혀 'Exploration is disarmed' 를 반복 출력하며
        # DDS discovery 가 늦어지는 그 몇 초~몇십 초 동안 실제로는 이미 arm 됐는데도
        # 움직이지 않는 원인이었다(실기 확인). status_qos(TRANSIENT_LOCAL) 로 맞춘다 —
        # navigate_goal.py·patrol_route.py·inspection_patrol.py 는 이미 이렇게 하고 있다.
        self.create_subscription(
            String,
            "/bbiyong/control_mode",
            self._on_control_mode,
            status_qos,
            callback_group=control_callbacks,
        )
        self.create_subscription(
            Bool,
            "/bbiyong/estop",
            self._on_estop,
            status_qos,
            callback_group=control_callbacks,
        )
        self._completed_publisher = self.create_publisher(
            Bool, "~/completed", status_qos
        )
        self._state_publisher = self.create_publisher(String, "~/state", status_qos)
        self.create_subscription(
            String, "/escape/state", self._on_escape_state, status_qos)
        # trail_layer 는 상시 nav2 스택에 살아 이전 실행의 자취를 들고 있다.
        # 이 노드는 실행마다 새로 뜨므로 여기가 곧 세션 경계다.
        self._trail_reset_client = self.create_client(Empty, "/trail_layer/reset")
        self._trail_reset_attempts = 0
        self._trail_reset_timer = self.create_timer(1.0, self._reset_trail)
        self._estop_publisher = self.create_publisher(
            Bool, "/bbiyong/estop_request", 10
        )
        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self)
        self._navigation_client = ActionClient(
            self,
            NavigateToPose,
            str(self.get_parameter("navigate_to_pose_action").value),
        )
        self.create_timer(
            float(self.get_parameter("planning_period_sec").value), self._tick
        )
        self._publish_completed(False)
        self._publish_state("waiting_for_map")

    def _on_map(self, message: OccupancyGrid) -> None:
        self._map = message

    def _on_odom(self, message: Odometry) -> None:
        position = (
            message.pose.pose.position.x,
            message.pose.pose.position.y,
        )
        self._latest_odom_position = position
        if self._phase == "follow_perimeter" and self._last_odom_position is not None:
            step = hypot(
                position[0] - self._last_odom_position[0],
                position[1] - self._last_odom_position[1],
            )
            # Ignore odometry discontinuities. Normal exploration motion between
            # 20 Hz samples is far below this threshold.
            if step <= 0.5:
                self._perimeter_travel_m += step
        self._last_odom_position = position

    def _on_control_mode(self, message: String) -> None:
        requested = message.data.strip().lower()
        if requested != self._control_mode:
            self._control_mode = requested
            self.get_logger().info(f"Explorer control mode: {requested}")

    def _on_estop(self, message: Bool) -> None:
        requested = bool(message.data)
        if requested != self._estop:
            self._estop = requested
            state = "active" if requested else "released"
            self.get_logger().warning(f"Explorer emergency stop: {state}")
            if requested:
                if self._goal_pending and self._goal_handle is None:
                    # Invalidate a goal request whose action response has not
                    # arrived. The stale-response callback cancels it if Nav2
                    # accepted it in the meantime.
                    self._goal_sequence += 1
                    self._clear_active_goal()
                elif self._goal_handle is not None:
                    # Do not set _cancel_requested: the result callback then
                    # classifies STATUS_CANCELED as an operator cancellation
                    # and deliberately avoids blacklisting the frontier.
                    self._goal_handle.cancel_goal_async()
                    self.get_logger().info(
                        "Cancelling active frontier goal after operator stop"
                    )

    def _publish_completed(self, completed: bool) -> None:
        self._completed_publisher.publish(Bool(data=completed))

    def _publish_state(self, state: str) -> None:
        self._state_publisher.publish(String(data=state))

    def _grid_from_message(self, message: OccupancyGrid) -> GridSpec:
        orientation = message.info.origin.orientation
        yaw = atan2(
            2.0 * (orientation.w * orientation.z + orientation.x * orientation.y),
            1.0 - 2.0 * (orientation.y * orientation.y + orientation.z * orientation.z),
        )
        original = GridSpec(
            width=message.info.width,
            height=message.info.height,
            resolution=message.info.resolution,
            origin_x=message.info.origin.position.x,
            origin_y=message.info.origin.position.y,
            origin_yaw=yaw,
            data=message.data,
        )
        target_resolution = float(
            self.get_parameter("analysis_resolution_m").value
        )
        factor = max(1, round(target_resolution / original.resolution))
        if factor == 1:
            return original

        occupied_threshold = int(self.get_parameter("occupied_threshold").value)
        free_threshold = int(self.get_parameter("free_threshold").value)
        coarse_width = ceil(original.width / factor)
        coarse_height = ceil(original.height / factor)
        coarse_data: list[int] = []
        for coarse_y in range(coarse_height):
            for coarse_x in range(coarse_width):
                values = [
                    original.value((x, y))
                    for y in range(
                        coarse_y * factor,
                        min(original.height, (coarse_y + 1) * factor),
                    )
                    for x in range(
                        coarse_x * factor,
                        min(original.width, (coarse_x + 1) * factor),
                    )
                ]
                occupied = [value for value in values if value >= occupied_threshold]
                free = [value for value in values if 0 <= value <= free_threshold]
                known = [value for value in values if value >= 0]
                if occupied:
                    coarse_data.append(max(occupied))
                elif len(known) != len(values):
                    coarse_data.append(-1)
                elif len(free) == len(values):
                    coarse_data.append(min(free))
                elif known:
                    coarse_data.append(max(known))
                else:
                    coarse_data.append(-1)
        return GridSpec(
            width=coarse_width,
            height=coarse_height,
            resolution=original.resolution * factor,
            origin_x=original.origin_x,
            origin_y=original.origin_y,
            origin_yaw=original.origin_yaw,
            data=coarse_data,
        )

    def _robot_pose(self) -> tuple[Point, float] | None:
        try:
            transform = self._tf_buffer.lookup_transform(
                self._global_frame,
                self._robot_frame,
                Time(),
                timeout=Duration(seconds=0.2),
            )
        except TransformException as error:
            self.get_logger().warning(
                f"Waiting for {self._global_frame} -> {self._robot_frame} TF: {error}",
                throttle_duration_sec=5.0,
            )
            return None
        translation = transform.transform.translation
        orientation = transform.transform.rotation
        yaw = atan2(
            2.0
            * (
                orientation.w * orientation.z
                + orientation.x * orientation.y
            ),
            1.0
            - 2.0
            * (
                orientation.y * orientation.y
                + orientation.z * orientation.z
            ),
        )
        return (translation.x, translation.y), yaw

    def _set_phase(self, phase: str, reason: str) -> None:
        if phase == self._phase:
            return
        previous = self._phase
        self._phase = phase
        self._publish_state(f"strategy_{phase}")
        self.get_logger().info(
            f"Exploration strategy: {previous} -> {phase} ({reason})"
        )

    def _update_wall_observations(self, clusters) -> None:
        """Count structural-wall observations in consecutive analyses."""
        self._analysis_epoch += 1
        minimum_length = float(
            self.get_parameter("minimum_structural_wall_length_m").value
        )
        require_exterior = self._exploration_mode != "all_obstacles_then_return"
        signatures = {
            signature
            for cluster in clusters
            if (cluster.is_exterior or not require_exterior)
            and cluster.wall_length_m >= minimum_length
            if (signature := wall_signature(cluster)) is not None
        }
        for signature in signatures:
            count, last_epoch = self._wall_observations.get(signature, (0, -1))
            count = count + 1 if last_epoch == self._analysis_epoch - 1 else 1
            self._wall_observations[signature] = (count, self._analysis_epoch)
        self._wall_observations = {
            signature: observation
            for signature, observation in self._wall_observations.items()
            if observation[1] >= self._analysis_epoch - 2
        }

    def _wall_is_stable(self, cluster) -> bool:
        signature = wall_signature(cluster)
        if signature is None:
            return False
        count, _ = self._wall_observations.get(signature, (0, -1))
        return count >= int(self.get_parameter("wall_persistence_updates").value)

    def _start_perimeter(
        self,
        robot_position: Point,
        robot_heading: float,
        wall_point: Point,
    ) -> None:
        self._set_phase("follow_perimeter", "stable structural wall acquired")
        self._perimeter_start_position = robot_position
        self._perimeter_start_heading = robot_heading
        self._perimeter_travel_m = 0.0
        self._last_odom_position = self._latest_odom_position
        self._last_wall_point = wall_point
        self._wall_lost_count = 0
        self._acquire_goal_count = 0
        self._active_wall_points = [wall_point]

    def _record_active_wall_point(self, wall_point: Point) -> None:
        spacing = float(
            self.get_parameter("completed_wall_sample_spacing_m").value
        )
        if not self._active_wall_points or hypot(
            wall_point[0] - self._active_wall_points[-1][0],
            wall_point[1] - self._active_wall_points[-1][1],
        ) >= spacing:
            self._active_wall_points.append(wall_point)

    def _complete_perimeter_loop(self, reason: str) -> None:
        self._completed_wall_points.extend(self._active_wall_points)
        self._active_wall_points = []
        self._last_wall_point = None
        self._wall_lost_count = 0
        self._acquire_goal_count = 0
        self._wall_observations.clear()
        if self._exploration_mode == "all_obstacles_then_return":
            self._set_phase("acquire_boundary", reason)
        else:
            self._set_phase("cleanup", reason)

    def _finish_perimeter(self, reason: str) -> None:
        self._set_phase("cleanup", reason)
        self._active_wall_points = []
        self._last_wall_point = None
        self._wall_lost_count = 0

    def _check_no_progress(self) -> bool:
        """갈 곳을 못 찾은 채 시간이 지나면 탐사를 끝낸다. 끝냈으면 True.

        [2026-08-08] 사용자 지침: 시연에서 30초 넘게 멈춰 있는 것은 허용되지 않는다.
        실측: "1 frontiers exist but none passed goal filters" 를 526회 반복하며
        로봇이 4.79m 에서 영원히 멈춰 있었다. 탐사에 포기 조건이 없었기 때문이다.

        완료 처리는 실패가 아니다 — 지금까지 그린 지도를 저장시켜 다음 단계(순찰)로
        갈 수 있게 한다. 좁은 환경에서 회전 가능한 프런티어가 없는 것은
        L0(clearance 0.40) 의 의도된 트레이드오프이지 고장이 아니다.
        """
        if self._completed:
            return False
        now = time.monotonic()
        # 목표를 실행 중이면(주행 중) 그 자체가 진전이다 — 발동하지 않는다.
        if self._goal_pending or self._goal_handle is not None:
            self._last_progress_at = now
            return False
        if self._last_progress_at is None:
            self._last_progress_at = now
            return False
        limit = float(self.get_parameter("no_progress_timeout_sec").value)
        if now - self._last_progress_at < limit:
            return False
        self.get_logger().warning(
            "no reachable goal for %.0fs -- finishing exploration with the map "
            "drawn so far (a partial map beats an endless wait)" % limit
        )
        self._mark_completed(
            "Exploration finished: no reachable frontier for %.0fs" % limit
        )
        return True

    def _tick(self) -> None:
        if self._check_no_progress():
            return
        if self._completed or self._safety_halt:
            return
        if self._escaping:
            self._publish_state("escaping_from_stuck")
            return
        if self._estop or self._control_mode != "autonomy":
            self._publish_state("waiting_for_autonomy_arm")
            self.get_logger().warning(
                "Exploration is disarmed; run `bbiyong arm-autonomy` "
                "after Nav2 is active",
                throttle_duration_sec=10.0,
            )
            # 🔴 [2026-08-10] 무장 대기는 "진전 없음" 이 아니라 "아직 시작하지 않음" 이다.
            # 여기서 그냥 return 하면 _check_no_progress() 의 no_progress_timeout_sec(30초)가
            # 무장을 기다리는 동안에도 계속 흘러, 목표를 한 번도 못 내보고 탐사가 끝난다.
            # 실측 2026-08-10: 15:15:48 control_state_bridge 가 autonomy/estop=false 발행(무장 완료)
            #   -> 15:15:50 / 15:16:01 / 15:16:11 여전히 "Exploration is disarmed"(래치값 미수신)
            #   -> 15:16:21 "no reachable goal for 30s -- finishing exploration" 로 자체 종료.
            # status_qos(TRANSIENT_LOCAL, 189-206행 주석 참고)로 래치값을 받게 돼 있으나 이 Orin 은
            # DDS 디스커버리가 만성적으로 느려(/dev/shm fastrtps 세그먼트 130개 이상) 30초를 넘긴다.
            # 매 tick 갱신해 무장된 순간부터 30초가 새로 시작되게 한다.
            self._last_progress_at = time.monotonic()
            return
        now = monotonic()
        self._blacklist = [
            entry for entry in self._blacklist if entry.expires_at > now
        ]
        self._discarded_walls = [
            entry for entry in self._discarded_walls if entry.expires_at > now
        ]
        discarded_wall_points = [entry.point for entry in self._discarded_walls]

        if self._goal_pending or self._goal_handle is not None:
            if self._goal_handle is None:
                response_timeout = float(
                    self.get_parameter("goal_response_timeout_sec").value
                )
                if now - self._goal_started_at >= response_timeout:
                    self._goal_sequence += 1
                    self.get_logger().error("Nav2 goal response timed out")
                    self._record_goal_failure("goal_response_timeout")
                return
            timeout = self._goal_timeout_sec
            cancel_grace = float(self.get_parameter("cancel_grace_sec").value)
            if (
                self._cancel_requested
                and now - self._goal_started_at >= timeout + cancel_grace
            ):
                self._goal_sequence += 1
                self._estop_publisher.publish(Bool(data=True))
                self._record_goal_failure("cancel_timeout")
                self._safety_halt = True
                self._publish_state("estopped_after_cancel_timeout")
                self.get_logger().error(
                    "Goal cancellation timed out; emergency stop activated"
                )
                return
            if not self._cancel_requested and now - self._goal_started_at >= timeout:
                self._cancel_requested = True
                self._publish_state("cancelling_timed_out_goal")
                self.get_logger().warning("Frontier goal timed out; cancelling it")
                self._goal_handle.cancel_goal_async()
            return
        if self._map is None:
            self._publish_state("waiting_for_map")
            return
        startup_grace = float(self.get_parameter("startup_grace_sec").value)
        if now - self._started_at < startup_grace:
            self._publish_state("warming_up_map")
            return

        robot_pose = self._robot_pose()
        if robot_pose is None:
            self._publish_state("waiting_for_tf")
            return
        robot_position, robot_heading = robot_pose
        if self._start_pose is None:
            self._start_pose = (robot_position, robot_heading)
            self.get_logger().info(
                "Recorded exploration start pose at "
                f"({robot_position[0]:.2f}, {robot_position[1]:.2f})"
            )

        if self._phase == "return_to_start":
            self._send_return_goal(robot_position, robot_heading)
            return

        analysis_started_at = monotonic()
        grid = self._grid_from_message(self._map)
        robot_cell = grid.world_to_cell(robot_position)
        if robot_cell is None:
            self._publish_state("robot_outside_map")
            return

        clusters = detect_frontier_clusters(
            grid,
            robot_cell,
            free_threshold=int(self.get_parameter("free_threshold").value),
            min_cluster_size=int(self.get_parameter("min_cluster_size").value),
            occupied_threshold=int(self.get_parameter("occupied_threshold").value),
            min_obstacle_clearance_m=float(
                self.get_parameter("min_obstacle_clearance_m").value
            ),
            goal_standoff_m=float(self.get_parameter("goal_standoff_m").value),
            openness_radius_m=float(self.get_parameter("openness_radius_m").value),
            require_known_goal_clearance=bool(
                self.get_parameter("require_known_goal_clearance").value
            ),
            wall_search_radius_m=float(
                self.get_parameter("wall_search_radius_m").value
            ),
        )
        self._update_wall_observations(clusters)
        excluded_points = [entry.point for entry in self._blacklist]

        def choose_regular_frontier(
            prefer_exterior: bool,
            *,
            enforce_wall_band: bool = False,
        ):
            exclusion_radius = float(
                self.get_parameter("completed_wall_exclusion_radius_m").value
            )
            target_wall_distance = float(
                self.get_parameter("target_wall_distance_m").value
            )
            wall_tolerance = max(
                0.05,
                float(self.get_parameter("wall_distance_tolerance_m").value),
            )
            minimum_wall_length = float(
                self.get_parameter("minimum_structural_wall_length_m").value
            )
            eligible_clusters = [
                cluster
                for cluster in clusters
                if not enforce_wall_band
                or (
                    cluster.wall_point is not None
                    and cluster.wall_length_m >= minimum_wall_length
                    and abs(cluster.wall_distance_m - target_wall_distance)
                    <= wall_tolerance
                )
                if cluster.wall_point is None
                or not any(
                    hypot(
                        cluster.wall_point[0] - discarded[0],
                        cluster.wall_point[1] - discarded[1],
                    ) <= exclusion_radius
                    for discarded in discarded_wall_points
                )
            ]
            return select_frontier(
                grid,
                eligible_clusters,
                robot_position,
                blacklist=excluded_points,
                blacklist_radius=float(
                    self.get_parameter("blacklist_radius").value
                ),
                min_frontier_distance=float(
                    self.get_parameter("min_frontier_distance").value
                ),
                information_gain_weight=float(
                    self.get_parameter("information_gain_weight").value
                ),
                distance_weight=float(
                    self.get_parameter("distance_weight").value
                ),
                open_space_weight=float(
                    self.get_parameter("open_space_weight").value
                ),
                prefer_exterior=prefer_exterior,
                robot_heading=robot_heading,
                heading_change_weight=float(
                    self.get_parameter("heading_change_weight").value
                ),
            )

        def choose_perimeter_frontier(
            candidate_clusters,
            *,
            prefer_farthest_wall: bool = False,
            enforce_wall_distance: bool = True,
        ):
            exclusion_radius = float(
                self.get_parameter("completed_wall_exclusion_radius_m").value
            )
            excluded_walls = (
                self._completed_wall_points + discarded_wall_points
            )
            unvisited_clusters = [
                cluster
                for cluster in candidate_clusters
                if cluster.wall_point is not None
                and not any(
                    hypot(
                        cluster.wall_point[0] - completed[0],
                        cluster.wall_point[1] - completed[1],
                    ) <= exclusion_radius
                    for completed in excluded_walls
                )
            ]
            return select_perimeter_frontier(
                grid,
                unvisited_clusters,
                robot_position,
                robot_heading,
                wall_side=str(self.get_parameter("wall_side").value),
                target_wall_distance_m=float(
                    self.get_parameter("target_wall_distance_m").value
                ),
                wall_distance_tolerance_m=float(
                    self.get_parameter("wall_distance_tolerance_m").value
                ),
                minimum_structural_wall_length_m=float(
                    self.get_parameter("minimum_structural_wall_length_m").value
                ),
                perimeter_heading_weight=float(
                    self.get_parameter("perimeter_heading_weight").value
                ),
                previous_wall_point=self._last_wall_point,
                blacklist=excluded_points,
                blacklist_radius=float(
                    self.get_parameter("blacklist_radius").value
                ),
                min_frontier_distance=float(
                    self.get_parameter("min_frontier_distance").value
                ),
                require_exterior=(
                    self._exploration_mode != "all_obstacles_then_return"
                ),
                prefer_farthest_wall=prefer_farthest_wall,
                enforce_wall_distance=enforce_wall_distance,
            )

        selected = None
        selected_heading = None
        discard_wall_on_failure = False
        if self._phase == "follow_perimeter":
            if (
                self._perimeter_start_position is not None
                and loop_is_closed(
                    self._perimeter_start_position,
                    self._perimeter_start_heading,
                    robot_position,
                    robot_heading,
                    self._perimeter_travel_m,
                    minimum_travel_m=float(
                        self.get_parameter("minimum_loop_travel_m").value
                    ),
                    position_tolerance_m=float(
                        self.get_parameter("loop_position_tolerance_m").value
                    ),
                    heading_tolerance_rad=float(
                        self.get_parameter("loop_heading_tolerance_rad").value
                    ),
                )
            ):
                self._complete_perimeter_loop(
                    f"loop closed after {self._perimeter_travel_m:.1f}m"
                )
            else:
                selected = choose_perimeter_frontier(clusters)
                if selected is not None:
                    self._wall_lost_count = 0
                    self._last_wall_point = selected.wall_point
                    self._record_active_wall_point(selected.wall_point)
                    selected_heading = perimeter_heading(
                        grid,
                        selected,
                        str(self.get_parameter("wall_side").value),
                    )
                else:
                    self._wall_lost_count += 1
                    if self._wall_lost_count < int(
                        self.get_parameter("wall_lost_updates").value
                    ):
                        self._publish_state("waiting_for_wall_continuation")
                        self.get_logger().warning(
                            "Structural-wall continuation not visible; "
                            f"waiting {self._wall_lost_count}/"
                            f"{self.get_parameter('wall_lost_updates').value}",
                            throttle_duration_sec=2.0,
                        )
                        return
                    self._set_phase(
                        "acquire_boundary",
                        "structural wall lost for consecutive analyses",
                    )
                    self._last_wall_point = None
                    self._wall_lost_count = 0
                    self._acquire_goal_count = 0

        if self._phase == "acquire_boundary" and selected is None:
            stable_clusters = [
                cluster for cluster in clusters if self._wall_is_stable(cluster)
            ]
            while stable_clusters:
                wall_candidate = choose_perimeter_frontier(
                    stable_clusters,
                    prefer_farthest_wall=True,
                    enforce_wall_distance=False,
                )
                if wall_candidate is None:
                    break
                selected = project_wall_standoff_cluster(
                    grid,
                    wall_candidate,
                    robot_position,
                    target_wall_distance_m=float(
                        self.get_parameter("target_wall_distance_m").value
                    ),
                    wall_distance_tolerance_m=float(
                        self.get_parameter("wall_distance_tolerance_m").value
                    ),
                    min_obstacle_clearance_m=float(
                        self.get_parameter("min_obstacle_clearance_m").value
                    ),
                    free_threshold=int(self.get_parameter("free_threshold").value),
                    occupied_threshold=int(
                        self.get_parameter("occupied_threshold").value
                    ),
                )
                if selected is not None:
                    break
                self._discard_wall(wall_candidate.wall_point)
                discarded_wall_points.append(wall_candidate.wall_point)
                self.get_logger().warning(
                    "Discarded far wall with no valid "
                    f"{self.get_parameter('target_wall_distance_m').value:.2f}m"
                    " stand-off goal at "
                    f"({wall_candidate.wall_point[0]:.2f}, "
                    f"{wall_candidate.wall_point[1]:.2f})"
                )
            if selected is not None and selected.wall_point is not None:
                discard_wall_on_failure = True
                self._start_perimeter(
                    robot_position,
                    robot_heading,
                    selected.wall_point,
                )
                selected_heading = perimeter_heading(
                    grid,
                    selected,
                    str(self.get_parameter("wall_side").value),
                )
            elif choose_perimeter_frontier(
                clusters,
                enforce_wall_distance=False,
            ) is not None:
                self._publish_state("confirming_structural_wall")
                self.get_logger().info(
                    "Structural-wall candidate found; waiting for a "
                    "consistent map observation",
                    throttle_duration_sec=2.0,
                )
                return
            elif self._acquire_goal_count >= int(
                self.get_parameter("max_acquire_frontier_goals").value
            ):
                self._finish_perimeter(
                    "no structural wall found after boundary acquisition"
                )
            else:
                selected = choose_regular_frontier(
                    prefer_exterior=True,
                    enforce_wall_band=True,
                )
                if selected is not None:
                    discard_wall_on_failure = selected.wall_point is not None
                    self._acquire_goal_count += 1

        if (
            self._phase == "acquire_boundary"
            and selected is None
            and self._exploration_mode == "all_obstacles_then_return"
        ):
            # (2026-08-07) all_obstacles_then_return never transitions into
            # "cleanup" (see _complete_perimeter_loop) -- it goes straight
            # from acquire_boundary to return_to_start once no exterior
            # frontier remains. That silently skipped enclosed holes with no
            # exterior-reachable frontier (e.g. behind a free-standing
            # obstacle): the config's own comment already promised "obstacle
            # boundaries repeatedly, then final frontier cleanup, then
            # return", but the cleanup step never ran. Fall back to the same
            # interior-inclusive search cleanup uses before giving up.
            selected = choose_regular_frontier(prefer_exterior=False)

        if self._phase == "cleanup" and selected is None:
            # The cleanup pass intentionally includes enclosed holes and
            # interior clusters instead of forcing another exterior sweep.
            selected = choose_regular_frontier(prefer_exterior=False)

        if selected is not None and selected_heading is None:
            selected_heading = frontier_heading(grid, selected)

        self.get_logger().info(
            "Frontier analysis: "
            f"{grid.width}x{grid.height}, {len(clusters)} clusters, "
            f"phase={self._phase}, "
            f"{monotonic() - analysis_started_at:.2f}s"
        )
        if selected is None:
            if self._blacklist:
                self._no_frontier_since = None
                self._publish_state("waiting_for_blacklist_expiry")
                blacklist_waits = [
                    entry.expires_at - now for entry in self._blacklist
                ]
                self.get_logger().warning(
                    f"All {len(clusters)} frontiers are temporarily excluded; "
                    f"{len(blacklist_waits)} blacklisted, "
                    f"next retry in {min(blacklist_waits):.1f}s",
                    throttle_duration_sec=2.0,
                )
                return
            if clusters:
                self._no_frontier_since = None
                distances = [
                    hypot(
                        grid.cell_to_world(cluster.goal_cell)[0] - robot_position[0],
                        grid.cell_to_world(cluster.goal_cell)[1] - robot_position[1],
                    )
                    for cluster in clusters
                ]
                self._publish_state("frontiers_present_no_eligible_goal")
                self.get_logger().warning(
                    f"{len(clusters)} frontiers exist but none passed goal filters; "
                    f"goal distance range {min(distances):.2f}-{max(distances):.2f}m",
                    throttle_duration_sec=5.0,
                )
                return
            known_free = sum(
                1
                for value in grid.data
                if 0 <= value <= int(self.get_parameter("free_threshold").value)
            )
            minimum_known = int(self.get_parameter("minimum_known_free_cells").value)
            if known_free < minimum_known:
                self._no_frontier_since = None
                self._publish_state("waiting_for_larger_map")
                return
            if self._no_frontier_since is None:
                self._no_frontier_since = now
            self._publish_state("checking_completion")
            stable_sec = float(self.get_parameter("completion_stable_sec").value)
            if now - self._no_frontier_since >= stable_sec:
                if (
                    self._exploration_mode == "all_obstacles_then_return"
                    and self._start_pose is not None
                ):
                    self._set_phase(
                        "return_to_start",
                        "no frontiers remain after obstacle-boundary passes",
                    )
                    self._no_frontier_since = None
                    self._send_return_goal(robot_position, robot_heading)
                else:
                    self._mark_completed(
                        "No reachable frontiers remain; exploration completed"
                    )
            return

        self._no_frontier_since = None
        if self._estop or self._control_mode != "autonomy":
            self._publish_state("waiting_for_autonomy_arm")
            return
        # 목표를 새로 보내는 것은 진전이다.
        self._last_progress_at = time.monotonic()
        selected_point = grid.cell_to_world(selected.goal_cell)
        progress = hypot(
            selected_point[0] - robot_position[0],
            selected_point[1] - robot_position[1],
        )
        minimum_progress = float(
            self.get_parameter("min_goal_progress_m").value
        )
        if progress < minimum_progress:
            # 여기서 return 해도 완주로 새지 않는다: _no_frontier_since 는
            # 위에서 이미 None 으로 리셋됐고, 완료 타이머는 clusters 가
            # 완전히 빈 경우에만 돈다.
            self._stalled_goals += 1
            limit = int(self.get_parameter("stalled_goal_limit").value)
            self.get_logger().warning(
                f"Goal ({selected_point[0]:.2f}, {selected_point[1]:.2f}) is "
                f"only {progress:.2f}m away (minimum {minimum_progress:.2f}m); "
                f"not sending it ({self._stalled_goals}/{limit})",
                throttle_duration_sec=5.0,
            )
            if self._stalled_goals >= limit:
                self._stalled_goals = 0
                if selected.wall_point is not None:
                    self._discard_wall(selected.wall_point)
                    self.get_logger().warning(
                        "Perimeter stopped advancing along the wall at "
                        f"({selected.wall_point[0]:.2f}, "
                        f"{selected.wall_point[1]:.2f}); excluding it and "
                        "acquiring another boundary"
                    )
                self._set_phase(
                    "acquire_boundary",
                    "perimeter goal stopped making progress",
                )
                self._perimeter_start_position = None
                self._perimeter_travel_m = 0.0
                self._last_wall_point = None
                self._wall_lost_count = 0
                self._acquire_goal_count = 0
                self._active_wall_points = []
            self._publish_state("goal_below_minimum_progress")
            return
        self._stalled_goals = 0
        wall_range = (
            hypot(
                selected.wall_point[0] - robot_position[0],
                selected.wall_point[1] - robot_position[1],
            )
            if selected.wall_point is not None
            else float("nan")
        )
        self.get_logger().info(
            "Sending frontier goal directly to Nav2: "
            f"phase={self._phase}, "
            f"position=({selected_point[0]:.2f}, {selected_point[1]:.2f}), "
            f"clearance={selected.obstacle_clearance_m:.2f}m, "
            f"wall_distance={selected.wall_distance_m:.2f}m, "
            f"wall_range={wall_range:.2f}m"
        )
        self._send_goal(
            selected_point,
            selected_heading,
            hypot(
                selected_point[0] - robot_position[0],
                selected_point[1] - robot_position[1],
            ),
            wall_point=selected.wall_point,
            discard_wall_on_failure=discard_wall_on_failure,
        )

    def _pose(self, point: Point, heading: float) -> PoseStamped:
        pose = PoseStamped()
        pose.header.frame_id = self._global_frame
        pose.header.stamp = self.get_clock().now().to_msg()
        pose.pose.position.x = point[0]
        pose.pose.position.y = point[1]
        pose.pose.orientation.z = sin(heading / 2.0)
        pose.pose.orientation.w = cos(heading / 2.0)
        return pose

    def _mark_completed(self, message: str) -> None:
        self._completed = True
        self._publish_completed(True)
        self._publish_state("completed")
        self.get_logger().info(message)

    def _send_return_goal(
        self,
        robot_position: Point,
        robot_heading: float,
    ) -> None:
        if self._start_pose is None:
            return
        start_position, start_heading = self._start_pose
        distance = hypot(
            start_position[0] - robot_position[0],
            start_position[1] - robot_position[1],
        )
        tolerance = float(self.get_parameter("return_to_start_tolerance_m").value)
        heading_error = abs(
            atan2(
                sin(start_heading - robot_heading),
                cos(start_heading - robot_heading),
            )
        )
        heading_tolerance = float(
            self.get_parameter("return_to_start_heading_tolerance_rad").value
        )
        if distance <= tolerance and heading_error <= heading_tolerance:
            self._mark_completed(
                "Exploration completed; robot returned to start pose"
            )
            return

        # 안전망: 시작점 복귀가 끝내 판정되지 않으면 강제로 완료시킨다.
        # [2026-08-08] 이 허용오차가 Nav2 의 목표 허용오차와 정확히 같아서
        # (0.10 == xy_goal_tolerance, 0.175 == yaw_goal_tolerance) Nav2 는
        # "도착" 을 선언하는데 여기서는 "아직" 이 되어 574회를 반복했다.
        # 허용오차는 위에서 넓혔지만, 값이 다시 어긋나도 시연이 멈추지는
        # 않도록 횟수 상한을 둔다. 시작점에서 조금 떨어져 저장되는 것은
        # 지도 품질과 무관하다 — 지도를 못 만드는 것보다 훨씬 낫다.
        self._return_attempts = getattr(self, "_return_attempts", 0) + 1
        if self._return_attempts > 40:
            self.get_logger().warning(
                "return_to_start did not converge in %d attempts "
                "(distance %.3f m > %.3f, heading %.3f rad > %.3f); "
                "completing anyway so the map gets saved"
                % (self._return_attempts, distance, tolerance,
                   heading_error, heading_tolerance)
            )
            self._mark_completed(
                "Exploration completed; return-to-start gave up "
                "(tolerance mismatch safeguard)"
            )
            return

        self.get_logger().info(
            "Exploration coverage complete; returning to start at "
            f"({start_position[0]:.2f}, {start_position[1]:.2f})"
        )
        self._send_goal(
            start_position,
            start_heading,
            distance,
            goal_kind="return_to_start",
        )

    def _send_goal(
        self,
        point: Point,
        heading: float,
        path_length: float,
        *,
        goal_kind: str = "frontier",
        wall_point: Point | None = None,
        discard_wall_on_failure: bool = False,
    ) -> None:
        if self._estop or self._control_mode != "autonomy":
            self._publish_state("waiting_for_autonomy_arm")
            return
        wait_timeout = float(self.get_parameter("server_wait_timeout_sec").value)
        if not self._navigation_client.wait_for_server(timeout_sec=wait_timeout):
            self._publish_state("waiting_for_nav2")
            self.get_logger().warning(
                "NavigateToPose action server is unavailable",
                throttle_duration_sec=5.0,
            )
            return

        goal = NavigateToPose.Goal()
        goal.pose = self._pose(point, heading)

        self._goal_sequence += 1
        sequence = self._goal_sequence
        self._goal_point = point
        self._goal_kind = goal_kind
        self._goal_wall_point = wall_point
        self._discard_wall_on_failure = discard_wall_on_failure
        self._goal_started_at = monotonic()
        minimum_timeout = float(self.get_parameter("goal_timeout_sec").value)
        base_timeout = float(self.get_parameter("goal_timeout_base_sec").value)
        per_meter = float(self.get_parameter("goal_timeout_per_meter_sec").value)
        maximum_timeout = float(self.get_parameter("max_goal_timeout_sec").value)
        self._goal_timeout_sec = min(
            maximum_timeout,
            max(minimum_timeout, base_timeout + per_meter * path_length),
        )
        self._cancel_requested = False
        self._goal_pending = True
        self._publish_state("sending_goal")
        self.get_logger().info(
            f"Sending {path_length:.2f}m {goal_kind} path with "
            f"{self._goal_timeout_sec:.0f}s timeout"
        )
        future = self._navigation_client.send_goal_async(goal)
        self._goal_response_future = future
        future.add_done_callback(
            lambda completed_future: self._on_goal_response(completed_future, sequence)
        )

    def _on_goal_response(self, future, sequence: int) -> None:
        if future is self._goal_response_future:
            self._goal_response_future = None
        if sequence != self._goal_sequence:
            try:
                stale_handle = future.result()
                if stale_handle.accepted:
                    stale_handle.cancel_goal_async()
            except Exception:
                pass
            return
        self._goal_pending = False
        try:
            goal_handle = future.result()
        except Exception as error:  # rclpy futures surface transport failures here
            self.get_logger().error(f"Failed to send frontier goal: {error}")
            self._record_goal_failure("goal_request_error")
            return
        if not goal_handle.accepted:
            self.get_logger().warning("Nav2 rejected frontier goal")
            self._record_goal_failure("goal_rejected")
            return

        self._goal_handle = goal_handle
        self._publish_state("navigating")
        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(
            lambda completed_future: self._on_goal_result(completed_future, sequence)
        )

    def _on_goal_result(self, future, sequence: int) -> None:
        if sequence != self._goal_sequence:
            return
        try:
            status = future.result().status
        except Exception as error:
            self.get_logger().error(f"Failed to receive frontier goal result: {error}")
            status = GoalStatus.STATUS_UNKNOWN

        if status == GoalStatus.STATUS_SUCCEEDED:
            goal_kind = self._goal_kind
            self.get_logger().info(f"Reached {goal_kind} goal")
            self._publish_state(f"{goal_kind}_reached")
            self._clear_active_goal()
            if goal_kind == "return_to_start":
                self._publish_state("verifying_return_pose")
        elif status == GoalStatus.STATUS_CANCELED and not self._cancel_requested:
            self.get_logger().info(
                "Frontier goal was externally cancelled; not blacklisting it"
            )
            self._publish_state("goal_cancelled")
            self._clear_active_goal()
        else:
            self.get_logger().warning(f"Frontier goal failed with status {status}")
            if self._escape_cancel:
                reason = "wedged_in_lethal_space"
            elif status == GoalStatus.STATUS_CANCELED and self._cancel_requested:
                reason = "goal_timeout"
            else:
                reason = f"nav2_status_{status}"
            self._record_goal_failure(reason)

    def _reset_trail(self) -> None:
        """경로 다양화 자취를 이번 실행분으로 비운다 (trail_layer)."""
        self._trail_reset_attempts += 1
        if self._trail_reset_client.service_is_ready():
            self._trail_reset_client.call_async(Empty.Request())
            self._trail_reset_timer.cancel()
            self.get_logger().info("Cleared the route-diversity trail")
        elif self._trail_reset_attempts >= 10:
            self._trail_reset_timer.cancel()
            self.get_logger().info(
                "trail_layer reset service never appeared; continuing")

    def _on_escape_state(self, message: String) -> None:
        """escape_recovery 가 끼임을 발견하면 그 목표를 실패로 처리한다.

        후진 자체는 escape_recovery 가 한다. 여기서 할 일은 Nav2 목표를
        취소해 collision_monitor 가 /cmd_vel/autonomy 를 놓아주게 하는 것과,
        거기로 끌고 간 목표를 버리는 것이다. _cancel_requested 를 먼저 세워야
        _on_goal_result 가 '외부 취소'로 보고 그냥 넘기지 않고 실패로 기록한다.
        """
        state = message.data.split(":", 1)[0]
        if state == "escaping":
            if self._escaping:
                return
            self._escaping = True
            self.get_logger().warning(
                "Robot is wedged; backing out and discarding this goal")
            if self._goal_handle is not None and not self._cancel_requested:
                self._cancel_requested = True
                self._escape_cancel = True
                self._goal_handle.cancel_goal_async()
            self._publish_state("escaping_from_stuck")
        elif state in ("recovered", "aborted", "idle"):
            if self._escaping and state != "idle":
                self.get_logger().info(f"Escape finished ({state}); resuming")
            self._escaping = False

    def _record_goal_failure(self, reason: str) -> None:
        if self._goal_kind == "return_to_start":
            self.get_logger().warning(
                f"Return-to-start goal failed ({reason}); will retry"
            )
            self._publish_state(f"return_to_start_failed:{reason}")
            self._clear_active_goal()
            return
        if (
            self._discard_wall_on_failure
            and self._goal_wall_point is not None
            and reason != "goal_request_error"
        ):
            wall_point = self._goal_wall_point
            exclusion_radius = float(
                self.get_parameter("completed_wall_exclusion_radius_m").value
            )
            if not any(
                hypot(wall_point[0] - discarded[0], wall_point[1] - discarded[1])
                <= exclusion_radius
                for discarded in (entry.point for entry in self._discarded_walls)
            ):
                self._discard_wall(wall_point)
            self.get_logger().warning(
                "Discarded unreachable acquisition wall at "
                f"({wall_point[0]:.2f}, {wall_point[1]:.2f}): {reason}"
            )
            self._set_phase(
                "acquire_boundary",
                "farthest visible wall was unreachable",
            )
            self._perimeter_start_position = None
            self._perimeter_travel_m = 0.0
            self._last_wall_point = None
            self._wall_lost_count = 0
            self._acquire_goal_count = 0
            self._active_wall_points = []
        if self._goal_point is not None:
            self._record_failure_point(self._goal_point, reason)
        self._publish_state(f"goal_failed:{reason}")
        self._clear_active_goal()

    def _record_failure_point(self, point: Point, reason: str) -> None:
        self._blacklist_point(point)
        self.get_logger().warning(
            "Temporarily blacklisted failed frontier at "
            f"({point[0]:.2f}, {point[1]:.2f}): {reason}"
        )

    def _discard_wall(self, point: Point) -> None:
        """Exclude a wall temporarily, or for good once it keeps failing."""
        ttl = float(self.get_parameter("discarded_wall_ttl_sec").value)
        limit = int(self.get_parameter("discarded_wall_failure_limit").value)
        radius = float(
            self.get_parameter("completed_wall_exclusion_radius_m").value
        )
        failures = 1
        for index, (known, count) in enumerate(self._wall_failures):
            if hypot(point[0] - known[0], point[1] - known[1]) <= radius:
                failures = count + 1
                self._wall_failures[index] = (known, failures)
                break
        else:
            self._wall_failures.append((point, 1))
        permanent = ttl <= 0.0 or (limit > 0 and failures >= limit)
        expiry = float("inf") if permanent else monotonic() + ttl
        self._discarded_walls.append(BlacklistedGoal(point, expiry))
        if permanent:
            self.get_logger().warning(
                f"Wall at ({point[0]:.2f}, {point[1]:.2f}) retired after "
                f"{failures} failures; it will not be retried again"
            )

    def _blacklist_point(self, point: Point) -> None:
        ttl = float(self.get_parameter("blacklist_ttl_sec").value)
        self._blacklist.append(BlacklistedGoal(point, monotonic() + ttl))

    def _clear_active_goal(self) -> None:
        self._goal_pending = False
        self._goal_handle = None
        self._goal_response_future = None
        self._goal_point = None
        self._goal_started_at = 0.0
        self._goal_timeout_sec = float(self.get_parameter("goal_timeout_sec").value)
        self._cancel_requested = False
        self._goal_wall_point = None
        self._discard_wall_on_failure = False
        self._escape_cancel = False

    def cancel_active_goal(self) -> None:
        """Request cancellation so stopping this node does not leave Nav2 driving."""
        # The Nav2 runtime outlives this mission. Stop its velocity path first,
        # then cancel even when goal acceptance is still in flight.
        self._estop_publisher.publish(Bool(data=True))
        response_future = self._goal_response_future
        if self._goal_handle is None and response_future is not None:
            self.get_logger().info(
                "Waiting for pending frontier goal response before shutdown"
            )
            rclpy.spin_until_future_complete(self, response_future, timeout_sec=2.0)
        if self._goal_handle is None:
            if self._goal_pending:
                self._goal_sequence += 1
                self.get_logger().warning(
                    "Frontier goal response did not arrive before shutdown"
                )
            self._clear_active_goal()
            return
        self.get_logger().info("Cancelling active frontier goal before shutdown")
        future = self._goal_handle.cancel_goal_async()
        rclpy.spin_until_future_complete(self, future, timeout_sec=2.0)
        if not future.done():
            self.get_logger().error(
                "Frontier goal cancellation was not acknowledged before shutdown"
            )
        self._clear_active_goal()


def main(args=None) -> None:
    rclpy.init(args=args)
    node = FrontierExplorer()
    executor = MultiThreadedExecutor(num_threads=2)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.remove_node(node)
        if rclpy.ok():
            node.cancel_active_goal()
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
