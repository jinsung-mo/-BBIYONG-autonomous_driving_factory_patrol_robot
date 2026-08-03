"""ROS 2 node that sends frontier goals to Nav2."""

from __future__ import annotations

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
from rclpy.time import Time
from std_msgs.msg import Bool, String
from tf2_ros import Buffer, TransformException, TransformListener

from .frontier import (
    GridSpec,
    Point,
    detect_frontier_clusters,
    frontier_heading,
    loop_is_closed,
    perimeter_heading,
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
        self.declare_parameter("minimum_known_free_cells", 100)
        self.declare_parameter("free_threshold", 20)
        self.declare_parameter("min_cluster_size", 5)
        self.declare_parameter("occupied_threshold", 65)
        self.declare_parameter("analysis_resolution_m", 0.05)
        self.declare_parameter("min_obstacle_clearance_m", 0.30)
        self.declare_parameter("goal_standoff_m", 0.0)
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
        self._goal_kind = "frontier"

        map_qos = QoSProfile(depth=1)
        map_qos.reliability = ReliabilityPolicy.RELIABLE
        map_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        status_qos = QoSProfile(depth=1)
        status_qos.reliability = ReliabilityPolicy.RELIABLE
        status_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL

        self.create_subscription(
            OccupancyGrid,
            str(self.get_parameter("map_topic").value),
            self._on_map,
            map_qos,
        )
        self.create_subscription(Odometry, "/odom", self._on_odom, 20)
        control_callbacks = MutuallyExclusiveCallbackGroup()
        self.create_subscription(
            String,
            "/bbiyong/control_mode",
            self._on_control_mode,
            10,
            callback_group=control_callbacks,
        )
        self.create_subscription(
            Bool,
            "/bbiyong/estop",
            self._on_estop,
            10,
            callback_group=control_callbacks,
        )
        self._completed_publisher = self.create_publisher(
            Bool, "~/completed", status_qos
        )
        self._state_publisher = self.create_publisher(String, "~/state", status_qos)
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

    def _tick(self) -> None:
        if self._completed or self._safety_halt:
            return
        if self._estop or self._control_mode != "autonomy":
            self._publish_state("waiting_for_autonomy_arm")
            self.get_logger().warning(
                "Exploration is disarmed; run `bbiyong arm-autonomy` "
                "after Nav2 is active",
                throttle_duration_sec=10.0,
            )
            return
        now = monotonic()
        self._blacklist = [
            entry for entry in self._blacklist if entry.expires_at > now
        ]

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

        def choose_regular_frontier(prefer_exterior: bool):
            return select_frontier(
                grid,
                clusters,
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

        def choose_perimeter_frontier(candidate_clusters):
            exclusion_radius = float(
                self.get_parameter("completed_wall_exclusion_radius_m").value
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
                    for completed in self._completed_wall_points
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
            )

        selected = None
        selected_heading = None
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
            selected = choose_perimeter_frontier(stable_clusters)
            if selected is not None and selected.wall_point is not None:
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
            elif choose_perimeter_frontier(clusters) is not None:
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
                selected = choose_regular_frontier(prefer_exterior=True)
                if selected is not None:
                    self._acquire_goal_count += 1

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
        selected_point = grid.cell_to_world(selected.goal_cell)
        self.get_logger().info(
            "Sending frontier goal directly to Nav2: "
            f"phase={self._phase}, "
            f"position=({selected_point[0]:.2f}, {selected_point[1]:.2f}), "
            f"clearance={selected.obstacle_clearance_m:.2f}m, "
            f"wall_distance={selected.wall_distance_m:.2f}m"
        )
        self._send_goal(
            selected_point,
            selected_heading,
            hypot(
                selected_point[0] - robot_position[0],
                selected_point[1] - robot_position[1],
            ),
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
            reason = (
                "goal_timeout"
                if status == GoalStatus.STATUS_CANCELED and self._cancel_requested
                else f"nav2_status_{status}"
            )
            self._record_goal_failure(reason)

    def _record_goal_failure(self, reason: str) -> None:
        if self._goal_kind == "return_to_start":
            self.get_logger().warning(
                f"Return-to-start goal failed ({reason}); will retry"
            )
            self._publish_state(f"return_to_start_failed:{reason}")
            self._clear_active_goal()
            return
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
