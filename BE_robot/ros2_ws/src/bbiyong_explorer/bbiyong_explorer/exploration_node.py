"""ROS 2 node that sends frontier goals to Nav2."""

from __future__ import annotations

from dataclasses import dataclass
from math import atan2, cos, sin
from time import monotonic

import rclpy
from action_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose
from nav_msgs.msg import OccupancyGrid
from rclpy.action import ActionClient
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rclpy.time import Time
from std_msgs.msg import Bool, String
from tf2_ros import Buffer, TransformException, TransformListener

from .frontier import GridSpec, Point, detect_frontier_clusters, select_frontier


@dataclass
class BlacklistedGoal:
    point: Point
    expires_at: float


class FrontierExplorer(Node):
    """Choose reachable map frontiers and delegate motion to Nav2."""

    def __init__(self) -> None:
        super().__init__("frontier_explorer")

        self.declare_parameter("map_topic", "/map")
        self.declare_parameter("navigate_to_pose_action", "/navigate_to_pose")
        self.declare_parameter("global_frame", "map")
        self.declare_parameter("robot_frame", "base_link")
        self.declare_parameter("planning_period_sec", 1.0)
        self.declare_parameter("goal_timeout_sec", 90.0)
        self.declare_parameter("goal_response_timeout_sec", 5.0)
        self.declare_parameter("cancel_grace_sec", 3.0)
        self.declare_parameter("server_wait_timeout_sec", 2.0)
        self.declare_parameter("startup_grace_sec", 15.0)
        self.declare_parameter("completion_stable_sec", 15.0)
        self.declare_parameter("minimum_known_free_cells", 100)
        self.declare_parameter("free_threshold", 20)
        self.declare_parameter("min_cluster_size", 5)
        self.declare_parameter("occupied_threshold", 65)
        self.declare_parameter("min_obstacle_clearance_m", 0.25)
        self.declare_parameter("min_frontier_distance", 0.5)
        self.declare_parameter("information_gain_weight", 2.0)
        self.declare_parameter("distance_weight", 1.0)
        self.declare_parameter("blacklist_radius", 0.6)
        self.declare_parameter("blacklist_ttl_sec", 120.0)

        self._global_frame = str(self.get_parameter("global_frame").value)
        self._robot_frame = str(self.get_parameter("robot_frame").value)
        self._map: OccupancyGrid | None = None
        self._goal_pending = False
        self._goal_handle = None
        self._goal_point: Point | None = None
        self._goal_started_at = 0.0
        self._cancel_requested = False
        self._safety_halt = False
        self._goal_sequence = 0
        self._blacklist: list[BlacklistedGoal] = []
        self._started_at = monotonic()
        self._no_frontier_since: float | None = None
        self._completed = False

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
        self._completed_publisher = self.create_publisher(
            Bool, "~/completed", status_qos
        )
        self._state_publisher = self.create_publisher(String, "~/state", status_qos)
        self._estop_publisher = self.create_publisher(Bool, "/bbiyong/estop", 10)
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
        return GridSpec(
            width=message.info.width,
            height=message.info.height,
            resolution=message.info.resolution,
            origin_x=message.info.origin.position.x,
            origin_y=message.info.origin.position.y,
            origin_yaw=yaw,
            data=message.data,
        )

    def _robot_position(self) -> Point | None:
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
        return translation.x, translation.y

    def _tick(self) -> None:
        if self._completed or self._safety_halt:
            return
        now = monotonic()
        self._blacklist = [entry for entry in self._blacklist if entry.expires_at > now]

        if self._goal_pending or self._goal_handle is not None:
            if self._goal_handle is None:
                response_timeout = float(
                    self.get_parameter("goal_response_timeout_sec").value
                )
                if now - self._goal_started_at >= response_timeout:
                    self._goal_sequence += 1
                    self.get_logger().error("Nav2 goal response timed out")
                    self._record_goal_failure()
                return
            timeout = float(self.get_parameter("goal_timeout_sec").value)
            cancel_grace = float(self.get_parameter("cancel_grace_sec").value)
            if self._cancel_requested and now - self._goal_started_at >= timeout + cancel_grace:
                self._goal_sequence += 1
                self._estop_publisher.publish(Bool(data=True))
                self._record_goal_failure()
                self._safety_halt = True
                self._publish_state("estopped_after_cancel_timeout")
                self.get_logger().error("Goal cancellation timed out; emergency stop activated")
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

        robot_position = self._robot_position()
        if robot_position is None:
            self._publish_state("waiting_for_tf")
            return

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
        )
        selected = select_frontier(
            grid,
            clusters,
            robot_position,
            blacklist=[entry.point for entry in self._blacklist],
            blacklist_radius=float(self.get_parameter("blacklist_radius").value),
            min_frontier_distance=float(
                self.get_parameter("min_frontier_distance").value
            ),
            information_gain_weight=float(
                self.get_parameter("information_gain_weight").value
            ),
            distance_weight=float(self.get_parameter("distance_weight").value),
        )
        if selected is None:
            if self._blacklist:
                self._no_frontier_since = None
                self._publish_state("waiting_for_blacklist_expiry")
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
                self._completed = True
                self._publish_completed(True)
                self._publish_state("completed")
                self.get_logger().info("No reachable frontiers remain; exploration completed")
            return

        self._no_frontier_since = None
        self._send_goal(grid.cell_to_world(selected.goal_cell), robot_position)

    def _send_goal(self, point: Point, robot_position: Point) -> None:
        wait_timeout = float(self.get_parameter("server_wait_timeout_sec").value)
        if not self._navigation_client.wait_for_server(timeout_sec=wait_timeout):
            self._publish_state("waiting_for_nav2")
            self.get_logger().warning(
                "NavigateToPose action server is unavailable",
                throttle_duration_sec=5.0,
            )
            return

        goal = NavigateToPose.Goal()
        goal.pose = PoseStamped()
        goal.pose.header.frame_id = self._global_frame
        goal.pose.header.stamp = self.get_clock().now().to_msg()
        goal.pose.pose.position.x = point[0]
        goal.pose.pose.position.y = point[1]
        heading = atan2(point[1] - robot_position[1], point[0] - robot_position[0])
        goal.pose.pose.orientation.z = sin(heading / 2.0)
        goal.pose.pose.orientation.w = cos(heading / 2.0)

        self._goal_sequence += 1
        sequence = self._goal_sequence
        self._goal_point = point
        self._goal_started_at = monotonic()
        self._cancel_requested = False
        self._goal_pending = True
        self._publish_state("sending_goal")
        future = self._navigation_client.send_goal_async(goal)
        future.add_done_callback(
            lambda completed_future: self._on_goal_response(completed_future, sequence)
        )

    def _on_goal_response(self, future, sequence: int) -> None:
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
            self._record_goal_failure()
            return
        if not goal_handle.accepted:
            self.get_logger().warning("Nav2 rejected frontier goal")
            self._record_goal_failure()
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
            self.get_logger().info("Reached frontier goal")
            self._publish_state("goal_reached")
            self._clear_active_goal()
        else:
            self.get_logger().warning(f"Frontier goal failed with status {status}")
            self._record_goal_failure()

    def _record_goal_failure(self) -> None:
        if self._goal_point is not None:
            ttl = float(self.get_parameter("blacklist_ttl_sec").value)
            self._blacklist.append(
                BlacklistedGoal(self._goal_point, monotonic() + ttl)
            )
        self._publish_state("goal_failed")
        self._clear_active_goal()

    def _clear_active_goal(self) -> None:
        self._goal_pending = False
        self._goal_handle = None
        self._goal_point = None
        self._goal_started_at = 0.0
        self._cancel_requested = False

    def cancel_active_goal(self) -> None:
        """Request cancellation so stopping this node does not leave Nav2 driving."""
        if self._goal_handle is None:
            return
        self.get_logger().info("Cancelling active frontier goal before shutdown")
        future = self._goal_handle.cancel_goal_async()
        rclpy.spin_until_future_complete(self, future, timeout_sec=2.0)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = FrontierExplorer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if rclpy.ok():
            node.cancel_active_goal()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
