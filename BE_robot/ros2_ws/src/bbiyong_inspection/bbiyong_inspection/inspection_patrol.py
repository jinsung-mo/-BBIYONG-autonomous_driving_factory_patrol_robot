#!/usr/bin/env python3
"""Cancelable sequential Nav2 patrol over confirmed inspection viewpoints.

This node is intentionally inert at startup. It requires an explicit START
command, autonomy control mode, and a cleared ESTOP. It never publishes Twist.
"""

from __future__ import annotations

import math
import time

from action_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose
import rclpy
from rclpy.action import ActionClient
from rclpy.node import Node
from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, String

from .protocol import decode_object, encode_object, validate_point


def yaw_quaternion(yaw):
    return math.sin(yaw * 0.5), math.cos(yaw * 0.5)


class InspectionPatrol(Node):
    TERMINAL = {"IDLE", "PAUSED", "COMPLETED", "FAILED", "ESTOPPED"}

    def __init__(self):
        super().__init__("bbiyong_inspection_patrol")
        self.declare_parameter("points_topic", "/inspection/points")
        self.declare_parameter("command_topic", "/inspection/patrol_command")
        self.declare_parameter("state_topic", "/inspection/patrol_state")
        self.declare_parameter("inspection_request_topic", "/inspection/check_request")
        self.declare_parameter("inspection_result_topic", "/inspection/check_result")
        self.declare_parameter("control_mode_topic", "/bbiyong/control_mode")
        self.declare_parameter("estop_topic", "/bbiyong/estop")
        self.declare_parameter("estop_request_topic", "/bbiyong/estop_request")
        self.declare_parameter("map_frame", "map")
        self.declare_parameter("map_id", "active-map")
        self.declare_parameter("loop_route", False)
        self.declare_parameter("goal_timeout_sec", 180.0)
        self.declare_parameter("cancel_timeout_sec", 3.0)
        self.declare_parameter("inspection_wait_sec", 2.0)
        self.declare_parameter("require_inspection_result", False)
        self.declare_parameter("skip_failed_points", True)
        self.declare_parameter("max_consecutive_failures", 3)

        self.map_frame = str(self.get_parameter("map_frame").value)
        self.map_id = str(self.get_parameter("map_id").value)
        self.loop_route = bool(self.get_parameter("loop_route").value)
        self.goal_timeout = float(self.get_parameter("goal_timeout_sec").value)
        self.cancel_timeout = float(self.get_parameter("cancel_timeout_sec").value)
        self.inspection_wait = float(
            self.get_parameter("inspection_wait_sec").value
        )
        self.require_inspection_result = bool(
            self.get_parameter("require_inspection_result").value
        )
        self.skip_failed = bool(self.get_parameter("skip_failed_points").value)
        self.max_failures = int(
            self.get_parameter("max_consecutive_failures").value
        )
        if min(self.goal_timeout, self.cancel_timeout, self.inspection_wait) <= 0.0:
            raise ValueError("mission timeouts must be positive")
        if self.max_failures < 1:
            raise ValueError("max_consecutive_failures must be positive")

        self.route = []
        self.route_revision = 0
        self.index = 0
        self.mode = "disabled"
        self.estop = True
        self.active_requested = False
        self.state = "IDLE"
        self.reason = ""
        self.current_point = None
        self.goal_future = None
        self.goal_handle = None
        self.result_future = None
        self.cancel_future = None
        self.cancel_deadline = None
        self.goal_deadline = None
        self.inspection_deadline = None
        self.pending_cancel_reason = None
        self.cancel_target_state = "PAUSED"
        self.consecutive_failures = 0

        latched = CONTROL_STATE_QOS
        self.state_publisher = self.create_publisher(
            String, str(self.get_parameter("state_topic").value), latched
        )
        self.inspection_publisher = self.create_publisher(
            String,
            str(self.get_parameter("inspection_request_topic").value),
            10,
        )
        self.estop_request_publisher = self.create_publisher(
            Bool, str(self.get_parameter("estop_request_topic").value), 10
        )
        self.client = ActionClient(self, NavigateToPose, "/navigate_to_pose")
        self.create_subscription(
            String,
            str(self.get_parameter("points_topic").value),
            self._on_points,
            latched,
        )
        self.create_subscription(
            String,
            str(self.get_parameter("command_topic").value),
            self._on_command,
            10,
        )
        self.create_subscription(
            String,
            str(self.get_parameter("inspection_result_topic").value),
            self._on_inspection_result,
            10,
        )
        self.create_subscription(
            String,
            str(self.get_parameter("control_mode_topic").value),
            self._on_mode,
            latched,
        )
        self.create_subscription(
            Bool,
            str(self.get_parameter("estop_topic").value),
            self._on_estop,
            latched,
        )
        self.create_timer(0.1, self._tick)
        self._publish_state()

    def _publish_state(self, state=None, reason=None):
        if state is not None:
            self.state = state
        if reason is not None:
            self.reason = reason
        point_id = self.current_point["id"] if self.current_point else None
        self.state_publisher.publish(String(data=encode_object(
            "inspection_patrol_state",
            state=self.state,
            reason=self.reason,
            mode=self.mode,
            estop=self.estop,
            activeRequested=self.active_requested,
            currentIndex=self.index,
            routeCount=len(self.route),
            pointId=point_id,
            consecutiveFailures=self.consecutive_failures,
            updatedAt=time.time(),
        )))

    def _motion_allowed(self):
        return self.active_requested and self.mode == "autonomy" and not self.estop

    def _on_points(self, message):
        try:
            payload = decode_object(message.data, kind="inspection_points")
            if str(payload.get("mapId", "")) != self.map_id:
                raise ValueError("route belongs to a different map")
            raw_points = payload.get("points", [])
            if not isinstance(raw_points, list):
                raise ValueError("points must be a list")
            points = [validate_point(raw) for raw in raw_points]
            points = [point for point in points if point["enabled"]]
            points.sort(key=lambda point: (point["sequence"], point["id"]))
            ids = [point["id"] for point in points]
            if len(ids) != len(set(ids)):
                raise ValueError("route contains duplicate point ids")
        except ValueError as exc:
            self.get_logger().warning(f"ignored invalid inspection route: {exc}")
            return

        changed = points != self.route
        self.route = points
        self.route_revision += 1
        if not changed:
            return
        if self.goal_future is not None or self.goal_handle is not None:
            self.active_requested = False
            self._request_cancel("route changed; explicit restart required", "PAUSED")
        elif self.state == "INSPECTING":
            self.active_requested = False
            self.current_point = None
            self.inspection_deadline = None
            self._publish_state("PAUSED", "route changed; explicit restart required")
        else:
            self.index = min(self.index, max(0, len(self.route) - 1))
            self._publish_state(reason="route updated")

    def _on_mode(self, message):
        mode = message.data.strip().lower()
        if mode not in {"disabled", "manual", "autonomy"}:
            return
        self.mode = mode
        if mode != "autonomy" and (
            self.goal_future is not None or self.goal_handle is not None
        ):
            self.active_requested = False
            self._request_cancel(f"control mode changed to {mode}", "PAUSED")
        elif mode != "autonomy" and self.state == "INSPECTING":
            self.active_requested = False
            self.current_point = None
            self.inspection_deadline = None
            self._publish_state("PAUSED", f"control mode changed to {mode}")
        else:
            self._publish_state()

    def _on_estop(self, message):
        self.estop = bool(message.data)
        if self.estop:
            self.active_requested = False
            if self.goal_future is not None or self.goal_handle is not None:
                self._request_cancel("emergency stop", "ESTOPPED")
            else:
                self.current_point = None
                self.inspection_deadline = None
                self._publish_state("ESTOPPED", "emergency stop")
        else:
            self._publish_state()

    def _on_command(self, message):
        try:
            payload = decode_object(message.data, kind="inspection_patrol_command")
            command = str(payload.get("command", "")).upper()
            if command == "START":
                if not self.route:
                    raise ValueError("no enabled inspection points")
                if "startIndex" in payload:
                    index = int(payload["startIndex"])
                    if not 0 <= index < len(self.route):
                        raise ValueError("startIndex is outside the route")
                    self.index = index
                elif self.state in {"IDLE", "COMPLETED", "FAILED", "ESTOPPED"}:
                    self.index = 0
                self.active_requested = True
                self.consecutive_failures = 0
                if self.estop:
                    self._publish_state("WAITING_FOR_SAFETY", "ESTOP is engaged")
                elif self.mode != "autonomy":
                    self._publish_state(
                        "WAITING_FOR_AUTONOMY", "control mode is not autonomy"
                    )
                else:
                    self._publish_state("STARTING", "")
            elif command in {"PAUSE", "STOP"}:
                self.active_requested = False
                target = "IDLE" if command == "STOP" else "PAUSED"
                if command == "STOP":
                    self.index = 0
                if self.goal_future is not None or self.goal_handle is not None:
                    self._request_cancel(command.lower(), target)
                else:
                    self.current_point = None
                    self.inspection_deadline = None
                    self._publish_state(target, command.lower())
            else:
                raise ValueError(f"unsupported patrol command: {command}")
        except (TypeError, ValueError) as exc:
            self.get_logger().warning(f"ignored invalid patrol command: {exc}")
            self._publish_state(reason=str(exc))

    def _tick(self):
        now = time.monotonic()
        if self.cancel_deadline is not None and now >= self.cancel_deadline:
            self.estop_request_publisher.publish(Bool(data=True))
            self._clear_goal()
            self.active_requested = False
            self._publish_state("FAILED", "Nav2 cancellation timed out; ESTOP requested")
            return
        if self.goal_deadline is not None and now >= self.goal_deadline:
            self._request_cancel("navigation goal timed out", "FAILED")
            return
        if self.state == "INSPECTING" and self.inspection_deadline is not None:
            if now >= self.inspection_deadline:
                if self.require_inspection_result:
                    self._point_failed("inspection result timed out")
                else:
                    self._point_complete()
            return
        if not self.active_requested:
            return
        if self.estop:
            self._publish_state("WAITING_FOR_SAFETY", "ESTOP is engaged")
            return
        if self.mode != "autonomy":
            self._publish_state("WAITING_FOR_AUTONOMY", "control mode is not autonomy")
            return
        if not self.route:
            self.active_requested = False
            self._publish_state("FAILED", "route is empty")
            return
        if self.goal_future is None and self.goal_handle is None:
            self._send_current_goal()

    def _send_current_goal(self):
        if not self.client.server_is_ready():
            self._publish_state("WAITING_FOR_NAV2", "navigate_to_pose is unavailable")
            return
        point = self.route[self.index]
        viewpoint = point["viewpoint"]
        pose = PoseStamped()
        pose.header.frame_id = self.map_frame
        pose.header.stamp = self.get_clock().now().to_msg()
        pose.pose.position.x = viewpoint["x"]
        pose.pose.position.y = viewpoint["y"]
        pose.pose.orientation.z, pose.pose.orientation.w = yaw_quaternion(
            viewpoint["yaw"]
        )
        goal = NavigateToPose.Goal()
        goal.pose = pose
        self.current_point = point
        revision = self.route_revision
        self._publish_state("NAVIGATING", "")
        future = self.client.send_goal_async(goal, feedback_callback=self._on_feedback)
        self.goal_future = future
        future.add_done_callback(
            lambda completed, expected=future, rev=revision: self._on_goal_response(
                completed, expected, rev
            )
        )

    def _on_feedback(self, feedback_message):
        if self.state != "NAVIGATING":
            return
        remaining = float(feedback_message.feedback.distance_remaining)
        self.reason = f"{remaining:.2f} m remaining"

    def _on_goal_response(self, future, expected, revision):
        if expected is not self.goal_future:
            return
        self.goal_future = None
        try:
            handle = future.result()
        except Exception as exc:
            self._point_failed(f"goal request failed: {exc}")
            return
        if not handle.accepted:
            if revision != self.route_revision:
                self.active_requested = False
                self._publish_state("PAUSED", "route changed before goal rejection")
                return
            self._point_failed("Nav2 rejected inspection goal")
            return
        self.goal_handle = handle
        self.goal_deadline = time.monotonic() + self.goal_timeout
        result_future = handle.get_result_async()
        self.result_future = result_future
        result_future.add_done_callback(
            lambda completed, expected=result_future: self._on_navigation_result(
                completed, expected
            )
        )
        # A route update can arrive while Nav2 is deciding whether to accept
        # the goal. An accepted stale goal must still be explicitly cancelled;
        # simply discarding this callback would leave the robot driving.
        if revision != self.route_revision:
            self.active_requested = False
            self._request_cancel("route changed before goal acceptance", "PAUSED")
            return
        if self.pending_cancel_reason is not None or not self._motion_allowed():
            reason = self.pending_cancel_reason or "motion authorization changed"
            self.pending_cancel_reason = None
            self._request_cancel(reason, self.cancel_target_state)

    def _on_navigation_result(self, future, expected):
        if expected is not self.result_future:
            return
        self._clear_goal(keep_point=True)
        try:
            status = future.result().status
        except Exception as exc:
            self._point_failed(f"navigation result failed: {exc}")
            return
        if status == GoalStatus.STATUS_SUCCEEDED:
            self.consecutive_failures = 0
            self._start_inspection()
        elif status == GoalStatus.STATUS_CANCELED:
            self.current_point = None
            self._publish_state(self.cancel_target_state, self.reason or "goal cancelled")
        else:
            self._point_failed(f"navigation action status {status}")

    def _start_inspection(self):
        if self.current_point is None:
            self._point_failed("arrival result has no current point")
            return
        self.inspection_deadline = time.monotonic() + self.inspection_wait
        self._publish_state("INSPECTING", "")
        self.inspection_publisher.publish(String(data=encode_object(
            "inspection_check_request",
            pointId=self.current_point["id"],
            target=self.current_point["target"],
            viewpoint=self.current_point["viewpoint"],
            expectedTagId=self.current_point.get("tagId"),
            timeoutSec=self.inspection_wait,
        )))

    def _on_inspection_result(self, message):
        if self.state != "INSPECTING" or self.current_point is None:
            return
        try:
            payload = decode_object(message.data, kind="inspection_check_result")
            if str(payload.get("pointId", "")) != self.current_point["id"]:
                return
            if not isinstance(payload.get("success"), bool):
                raise ValueError("inspection success must be a boolean")
            if payload["success"]:
                self._point_complete()
            else:
                self._point_failed(str(payload.get("reason", "inspection failed")))
        except ValueError as exc:
            self.get_logger().warning(f"ignored invalid inspection result: {exc}")

    def _point_complete(self):
        self.inspection_deadline = None
        self.current_point = None
        self.index += 1
        if self.index >= len(self.route):
            if self.loop_route and self._motion_allowed():
                self.index = 0
                self._publish_state("STARTING", "starting next patrol cycle")
            else:
                self.index = max(0, len(self.route) - 1)
                self.active_requested = False
                self._publish_state("COMPLETED", "inspection route completed")
        else:
            self._publish_state("STARTING", "advancing to next point")

    def _point_failed(self, reason):
        self._clear_goal(keep_point=True)
        self.inspection_deadline = None
        self.consecutive_failures += 1
        failed_point = self.current_point
        self.current_point = None
        if self.consecutive_failures >= self.max_failures or not self.skip_failed:
            self.active_requested = False
            self._publish_state("FAILED", reason)
            return
        self.index += 1
        if self.index >= len(self.route):
            if self.loop_route and self._motion_allowed():
                self.index = 0
            else:
                self.active_requested = False
                self._publish_state("COMPLETED", "route completed with failed points")
                return
        failed_id = failed_point["id"] if failed_point else "unknown"
        self._publish_state("STARTING", f"skipped {failed_id}: {reason}")

    def _request_cancel(self, reason, target_state):
        self.reason = reason
        self.cancel_target_state = target_state
        if self.goal_handle is None:
            if self.goal_future is not None:
                self.pending_cancel_reason = reason
                self.cancel_deadline = time.monotonic() + self.cancel_timeout
                self._publish_state("CANCELLING", reason)
            else:
                self._publish_state(target_state, reason)
            return
        if self.cancel_future is not None:
            return
        self.cancel_deadline = time.monotonic() + self.cancel_timeout
        self._publish_state("CANCELLING", reason)
        future = self.goal_handle.cancel_goal_async()
        self.cancel_future = future
        future.add_done_callback(
            lambda completed, expected=future: self._on_cancel_response(
                completed, expected
            )
        )

    def _on_cancel_response(self, future, expected):
        if expected is not self.cancel_future:
            return
        try:
            response = future.result()
            if not response.goals_canceling:
                raise RuntimeError("Nav2 did not acknowledge cancellation")
        except Exception as exc:
            self.estop_request_publisher.publish(Bool(data=True))
            self.active_requested = False
            self._clear_goal()
            self._publish_state("FAILED", f"{exc}; ESTOP requested")

    def _clear_goal(self, *, keep_point=False):
        self.goal_future = None
        self.goal_handle = None
        self.result_future = None
        self.cancel_future = None
        self.cancel_deadline = None
        self.goal_deadline = None
        self.pending_cancel_reason = None
        if not keep_point:
            self.current_point = None

    def request_shutdown(self):
        self.active_requested = False
        if self.goal_future is not None or self.goal_handle is not None:
            self._request_cancel("node shutdown", "IDLE")


def main(args=None):
    rclpy.init(args=args)
    node = InspectionPatrol()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        node.request_shutdown()
    finally:
        node.request_shutdown()
        # Give an accepted action a bounded opportunity to acknowledge
        # cancellation before destroying the client. The timer requests ESTOP
        # if the acknowledgement/result does not arrive in time.
        deadline = time.monotonic() + node.cancel_timeout + 0.5
        while (
            rclpy.ok()
            and (node.goal_future is not None or node.goal_handle is not None)
            and time.monotonic() < deadline
        ):
            rclpy.spin_once(node, timeout_sec=0.05)
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    main()
