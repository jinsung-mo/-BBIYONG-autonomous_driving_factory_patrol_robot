#!/usr/bin/env python3
"""Cancelable Nav2 FollowWaypoints patrol mission; never publishes velocity."""

from __future__ import annotations

import json
from pathlib import Path
import signal
import time

import rclpy
from action_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import FollowWaypoints
from rclpy.action import ActionClient
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import Bool, Int32, Int32MultiArray, String

from .patrol_route_model import load_route_document, resume_order, yaw_quaternion
from .scouting_session import read_ready_session, route_matches_session


class PatrolRoute(Node):
    def __init__(self):
        super().__init__("bbiyong_patrol_route")
        self.declare_parameter("route_file", "")
        self.declare_parameter("frame_id", "map")
        self.declare_parameter("loop_route", True)
        self.declare_parameter("consecutive_failure_limit", 3)
        self.declare_parameter("route_check_period_sec", 1.0)
        self.declare_parameter("retry_delay_sec", 2.0)
        self.declare_parameter("cancel_timeout_sec", 2.0)
        self.declare_parameter(
            "scouting_state_file", "/tmp/bbiyong_scouting_session.json"
        )

        self.route_file = Path(
            str(self.get_parameter("route_file").value)
        ).expanduser()
        self.frame_id = str(self.get_parameter("frame_id").value)
        self.loop_route = bool(self.get_parameter("loop_route").value)
        self.failure_limit = int(
            self.get_parameter("consecutive_failure_limit").value
        )
        check_period = float(
            self.get_parameter("route_check_period_sec").value
        )
        self.retry_delay = float(self.get_parameter("retry_delay_sec").value)
        self.cancel_timeout = float(
            self.get_parameter("cancel_timeout_sec").value
        )
        self.scouting_state_file = Path(
            str(self.get_parameter("scouting_state_file").value)
        ).expanduser()
        if (
            self.failure_limit <= 0
            or min(check_period, self.retry_delay, self.cancel_timeout) <= 0
        ):
            raise ValueError("route_file and positive patrol limits are required")

        status_qos = QoSProfile(
            depth=1,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            reliability=ReliabilityPolicy.RELIABLE,
        )
        self.state_publisher = self.create_publisher(
            String, "/bbiyong/patrol/state", status_qos
        )
        self.current_publisher = self.create_publisher(
            Int32, "/bbiyong/patrol/current_waypoint", status_qos
        )
        self.missed_publisher = self.create_publisher(
            Int32MultiArray, "/bbiyong/patrol/missed_waypoints", status_qos
        )
        self.estop_request_publisher = self.create_publisher(
            Bool, "/bbiyong/estop_request", 10
        )
        self.create_subscription(
            String, "/bbiyong/control_mode", self._on_mode, status_qos
        )
        self.create_subscription(Bool, "/bbiyong/estop", self._on_estop, status_qos)
        self.action_client = ActionClient(self, FollowWaypoints, "/follow_waypoints")

        self.mode = "disabled"
        self.estop = True
        self.state = "IDLE"
        self.failure_reason = ""
        self.route = []
        self.pending_route = None
        self.route_mtime_ns = None
        self.goal_handle = None
        self.goal_response_future = None
        self.cancel_future = None
        self.active_indices = []
        self.resume_index = 0
        self.missed_indices = []
        self.consecutive_failures = 0
        self.shutdown_requested = False
        self.retry_not_before = 0.0
        self.cancel_deadline = None
        self.pending_cancel_reason = None
        self.route_session_id = None
        self._reload_route(initial=True)
        self.create_timer(0.1, self._drive_state)
        self.create_timer(check_period, self._check_route_update)

    def _publish_state(self, state=None, reason=None):
        if state is not None:
            self.state = state
        if reason is not None:
            self.failure_reason = reason
        payload = {
            "state": self.state,
            "reason": self.failure_reason,
            "routeCount": len(self.route),
            "resumeIndex": self.resume_index,
            "missedWaypoints": self.missed_indices,
        }
        self.state_publisher.publish(String(data=json.dumps(payload)))
        self.missed_publisher.publish(Int32MultiArray(data=self.missed_indices))

    def _reload_route(self, initial=False):
        try:
            route, document = load_route_document(self.route_file)
            mtime_ns = self.route_file.stat().st_mtime_ns
            session = read_ready_session(self.scouting_state_file)
            if not route_matches_session(document, session):
                raise ValueError("route must be reapplied for the active scouting map")
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            if initial:
                self._publish_state("FAILED", f"invalid route: {exc}")
            else:
                self.get_logger().error(f"ignored invalid route replacement: {exc}")
            return False
        self.route_mtime_ns = mtime_ns
        self.route_session_id = session["sessionId"]
        if self.goal_handle is not None or self.goal_response_future is not None:
            self.pending_route = route
            self.get_logger().info("validated route replacement; cancelling active goal")
            self._request_cancel("route replaced")
        else:
            self.route = route
            self.resume_index = 0
            self.missed_indices = []
            self._publish_state("PAUSED" if initial else "IDLE", "")
        return True

    def _check_route_update(self):
        try:
            mtime_ns = self.route_file.stat().st_mtime_ns
        except OSError:
            return
        if self.route_mtime_ns != mtime_ns:
            self._reload_route()

    def _on_mode(self, message):
        requested = message.data.strip().lower()
        if requested in {"disabled", "manual", "autonomy"}:
            self.mode = requested
        if requested != "autonomy":
            self._request_cancel("manual mode" if requested == "manual" else "disabled")

    def _on_estop(self, message):
        self.estop = bool(message.data)
        if self.estop:
            self._request_cancel("emergency stop")

    def _motion_allowed(self):
        return self.mode == "autonomy" and not self.estop and not self.shutdown_requested

    def _drive_state(self):
        if self.shutdown_requested:
            if self.goal_handle is None and self.goal_response_future is None:
                if rclpy.ok(context=self.context):
                    rclpy.shutdown(context=self.context)
            elif self.cancel_deadline is not None and time.monotonic() >= self.cancel_deadline:
                self.get_logger().error("patrol cancellation timed out during shutdown")
                if rclpy.ok(context=self.context):
                    rclpy.shutdown(context=self.context)
            return
        session = read_ready_session(self.scouting_state_file)
        if not session or session.get("sessionId") != self.route_session_id:
            if self.goal_handle is not None or self.goal_response_future is not None:
                self._request_cancel("scouting session changed")
            self._publish_state("WAITING_FOR_ROUTE", "reapply route for active map")
            return
        if (
            self.cancel_deadline is not None
            and time.monotonic() >= self.cancel_deadline
            and self.goal_handle is not None
        ):
            self.estop_request_publisher.publish(Bool(data=True))
            self.cancel_deadline = None
            self._publish_state("FAILED", "patrol cancellation timed out")
            return
        if (
            not self._motion_allowed()
            or self.state in {"FAILED", "COMPLETED"}
            or time.monotonic() < self.retry_not_before
        ):
            return
        if self.goal_handle is None and self.goal_response_future is None:
            self._send_goal()

    def _poses(self):
        self.active_indices = resume_order(
            len(self.route), self.resume_index, self.loop_route
        )
        stamp = self.get_clock().now().to_msg()
        poses = []
        for index in self.active_indices:
            point = self.route[index]
            z, w = yaw_quaternion(point["yaw"])
            pose = PoseStamped()
            pose.header.frame_id = self.frame_id
            pose.header.stamp = stamp
            pose.pose.position.x = point["x"]
            pose.pose.position.y = point["y"]
            pose.pose.orientation.z = z
            pose.pose.orientation.w = w
            poses.append(pose)
        return poses

    def _send_goal(self):
        if not self.route:
            self._publish_state("FAILED", "route is empty")
            return
        if not self.action_client.server_is_ready():
            self._publish_state("WAITING_FOR_NAV2", "follow_waypoints unavailable")
            return
        goal = FollowWaypoints.Goal()
        goal.poses = self._poses()
        self._publish_state("STARTING", "")
        future = self.action_client.send_goal_async(
            goal, feedback_callback=self._on_feedback
        )
        self.goal_response_future = future
        future.add_done_callback(self._on_goal_response)

    def _on_goal_response(self, future):
        if future is not self.goal_response_future:
            return
        self.goal_response_future = None
        try:
            handle = future.result()
        except Exception as exc:
            self._record_failure(f"goal request failed: {exc}")
            return
        if not handle.accepted:
            self._record_failure("FollowWaypoints goal rejected")
            return
        self.goal_handle = handle
        self._publish_state("RUNNING", "")
        handle.get_result_async().add_done_callback(self._on_result)
        if self.pending_cancel_reason is not None:
            reason = self.pending_cancel_reason
            self.pending_cancel_reason = None
            self._request_cancel(reason)
        elif not self._motion_allowed():
            self._request_cancel("control changed before goal acceptance")

    def _on_feedback(self, feedback_message):
        offset = int(feedback_message.feedback.current_waypoint)
        if 0 <= offset < len(self.active_indices):
            self.resume_index = self.active_indices[offset]
            self.current_publisher.publish(Int32(data=self.resume_index))
            self._publish_state()

    def _missed_from_result(self, result):
        missed = []
        for item in getattr(result, "missed_waypoints", []):
            offset = int(getattr(item, "index", item))
            if 0 <= offset < len(self.active_indices):
                missed.append(self.active_indices[offset])
        return sorted(set(missed))

    def _on_result(self, future):
        handle = self.goal_handle
        self.goal_handle = None
        self.cancel_future = None
        self.cancel_deadline = None
        self.pending_cancel_reason = None
        try:
            wrapped = future.result()
            missed = self._missed_from_result(wrapped.result)
        except Exception as exc:
            self._record_failure(f"patrol result failed: {exc}")
            return
        if self.pending_route is not None:
            self.route = self.pending_route
            self.pending_route = None
            self.resume_index = 0
        if wrapped.status == GoalStatus.STATUS_CANCELED:
            self._publish_state("PAUSED", "patrol canceled")
            return
        if wrapped.status != GoalStatus.STATUS_SUCCEEDED:
            self._record_failure(f"patrol action status {wrapped.status}")
            return
        self.missed_indices = missed
        if missed:
            self.consecutive_failures += 1
            if self.consecutive_failures >= self.failure_limit:
                self._publish_state(
                    "FAILED",
                    f"missed waypoints for {self.consecutive_failures} cycles",
                )
                return
        else:
            self.consecutive_failures = 0
        self.resume_index = 0
        if self.loop_route and self._motion_allowed():
            self._publish_state("IDLE", "")
        else:
            self._publish_state("COMPLETED", "")

    def _record_failure(self, reason):
        self.goal_handle = None
        self.goal_response_future = None
        self.consecutive_failures += 1
        self.retry_not_before = time.monotonic() + self.retry_delay
        state = "FAILED" if self.consecutive_failures >= self.failure_limit else "BLOCKED"
        self._publish_state(state, reason)

    def _request_cancel(self, reason):
        if self.goal_handle is None:
            if self.goal_response_future is not None:
                self.pending_cancel_reason = reason
                self._publish_state("PAUSING", reason)
            else:
                self._publish_state("PAUSED", reason)
            return
        if self.cancel_future is not None:
            return
        self._publish_state("PAUSING", reason)
        self.cancel_deadline = time.monotonic() + self.cancel_timeout
        self.cancel_future = self.goal_handle.cancel_goal_async()
        self.cancel_future.add_done_callback(self._on_cancel_response)

    def _on_cancel_response(self, future):
        try:
            response = future.result()
            if not response.goals_canceling:
                self.get_logger().error("Nav2 did not acknowledge patrol cancellation")
        except Exception as exc:
            self.get_logger().error(f"patrol cancellation failed: {exc}")

    def request_shutdown(self):
        if self.shutdown_requested:
            return
        self.shutdown_requested = True
        self.cancel_deadline = time.monotonic() + self.cancel_timeout
        self.estop_request_publisher.publish(Bool(data=True))
        self._request_cancel("mission shutdown")


def main(args=None):
    rclpy.init(args=args)
    node = PatrolRoute()

    def stop_handler(_signum, _frame):
        node.request_shutdown()

    previous_handlers = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, stop_handler)
    try:
        rclpy.spin(node)
    finally:
        node.request_shutdown()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    main()
