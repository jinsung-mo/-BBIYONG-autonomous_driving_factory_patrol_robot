#!/usr/bin/env python3
"""Cancelable one-off NavigateToPose mission; never publishes velocity."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import time

import rclpy
from action_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose
from rclpy.action import ActionClient
from rclpy.node import Node
from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, String

from .patrol_route_model import validate_goal, yaw_quaternion
from .scouting_session import read_ready_session


def atomic_write_json(path, payload):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    os.replace(temporary, target)


class NavigateGoal(Node):
    TERMINAL = {"SUCCEEDED", "CANCELLED", "FAILED", "REJECTED"}

    def __init__(self):
        super().__init__("bbiyong_navigate_goal")
        self.declare_parameter("x", float("nan"))
        self.declare_parameter("y", float("nan"))
        self.declare_parameter("yaw", 0.0)
        self.declare_parameter("frame_id", "map")
        self.declare_parameter("state_file", "/tmp/bbiyong_navigate_goal.json")
        self.declare_parameter("cancel_timeout_sec", 2.0)
        self.declare_parameter(
            "scouting_state_file", "/tmp/bbiyong_scouting_session.json"
        )
        self.goal = validate_goal(
            self.get_parameter("x").value,
            self.get_parameter("y").value,
            self.get_parameter("yaw").value,
        )
        self.frame_id = str(self.get_parameter("frame_id").value)
        self.state_file = Path(str(self.get_parameter("state_file").value)).expanduser()
        self.cancel_timeout = float(self.get_parameter("cancel_timeout_sec").value)
        self.scouting_state_file = Path(
            str(self.get_parameter("scouting_state_file").value)
        ).expanduser()
        if self.cancel_timeout <= 0.0:
            raise ValueError("cancel_timeout_sec must be positive")

        qos = CONTROL_STATE_QOS
        self.state_publisher = self.create_publisher(
            String, "/bbiyong/navigation_goal/state", qos
        )
        self.estop_request_publisher = self.create_publisher(
            Bool, "/bbiyong/estop_request", 10
        )
        self.create_subscription(String, "/bbiyong/control_mode", self._on_mode, qos)
        self.create_subscription(Bool, "/bbiyong/estop", self._on_estop, qos)
        self.client = ActionClient(self, NavigateToPose, "/navigate_to_pose")
        self.mode = "disabled"
        self.estop = True
        self.state = "WAITING_FOR_AUTONOMY"
        self.reason = ""
        self.goal_response_future = None
        self.goal_handle = None
        self.cancel_future = None
        self.cancel_deadline = None
        self.shutdown_requested = False
        self.exit_code = None
        self.started = False
        self.pending_cancel_reason = None
        self._publish()
        self.create_timer(0.1, self._tick)

    def _publish(self, state=None, reason=None):
        if state is not None:
            self.state = state
        if reason is not None:
            self.reason = reason
        payload = {
            "state": self.state,
            "reason": self.reason,
            "goal": self.goal,
            "updatedAt": time.time(),
        }
        self.state_publisher.publish(String(data=json.dumps(payload)))
        try:
            atomic_write_json(self.state_file, payload)
        except OSError as exc:
            self.get_logger().error(f"failed to persist navigation state: {exc}")

    def _on_mode(self, message):
        mode = message.data.strip().lower()
        if mode in {"disabled", "manual", "autonomy"}:
            self.mode = mode
        if mode != "autonomy" and self.started:
            self._cancel("manual mode" if mode == "manual" else "disabled")

    def _on_estop(self, message):
        self.estop = bool(message.data)
        if self.estop and self.started:
            self._cancel("emergency stop")

    def _allowed(self):
        return self.mode == "autonomy" and not self.estop and not self.shutdown_requested

    def _tick(self):
        if self.cancel_deadline and time.monotonic() >= self.cancel_deadline:
            self.estop_request_publisher.publish(Bool(data=True))
            self._finish("FAILED", "navigation cancellation timed out", 1)
            return
        if self.state in {
            "WAITING_FOR_AUTONOMY",
            "WAITING_FOR_LOCALIZATION",
            "WAITING_FOR_NAV2",
        } and self._allowed():
            self._send()
        if self.exit_code is not None and self.goal_handle is None:
            if rclpy.ok(context=self.context):
                rclpy.shutdown(context=self.context)

    def _send(self):
        if read_ready_session(self.scouting_state_file) is None:
            self._publish("WAITING_FOR_LOCALIZATION", "saved-map localization unavailable")
            return
        self.started = True
        if not self.client.server_is_ready():
            self._publish("WAITING_FOR_NAV2", "navigate_to_pose unavailable")
            return
        pose = PoseStamped()
        pose.header.frame_id = self.frame_id
        pose.header.stamp = self.get_clock().now().to_msg()
        pose.pose.position.x = self.goal["x"]
        pose.pose.position.y = self.goal["y"]
        pose.pose.orientation.z, pose.pose.orientation.w = yaw_quaternion(
            self.goal["yaw"]
        )
        goal = NavigateToPose.Goal()
        goal.pose = pose
        self._publish("STARTING", "")
        self.goal_response_future = self.client.send_goal_async(goal)
        self.goal_response_future.add_done_callback(self._on_goal_response)

    def _on_goal_response(self, future):
        if future is not self.goal_response_future:
            return
        self.goal_response_future = None
        try:
            handle = future.result()
        except Exception as exc:
            self._finish("FAILED", f"goal request failed: {exc}", 1)
            return
        if not handle.accepted:
            self._finish("REJECTED", "NavigateToPose goal rejected", 2)
            return
        self.goal_handle = handle
        self._publish("ACCEPTED", "")
        handle.get_result_async().add_done_callback(self._on_result)
        if self.pending_cancel_reason is not None:
            reason = self.pending_cancel_reason
            self.pending_cancel_reason = None
            self._cancel(reason)
        elif not self._allowed():
            self._cancel("control changed before goal acceptance")

    def _on_result(self, future):
        self.goal_handle = None
        self.cancel_future = None
        self.cancel_deadline = None
        self.pending_cancel_reason = None
        try:
            status = future.result().status
        except Exception as exc:
            self._finish("FAILED", f"navigation result failed: {exc}", 1)
            return
        if status == GoalStatus.STATUS_SUCCEEDED:
            self._finish("SUCCEEDED", "", 0)
        elif status == GoalStatus.STATUS_CANCELED:
            self._finish("CANCELLED", "navigation goal cancelled", 130)
        else:
            self._finish("FAILED", f"navigation action status {status}", 1)

    def _cancel(self, reason):
        if self.goal_handle is None:
            if self.goal_response_future is not None:
                self.pending_cancel_reason = reason
                self.cancel_deadline = time.monotonic() + self.cancel_timeout
                self._publish("CANCELLING", reason)
            elif self.state not in self.TERMINAL:
                self._finish("CANCELLED", reason, 130)
            return
        if self.cancel_future is not None:
            return
        self._publish("CANCELLING", reason)
        self.cancel_deadline = time.monotonic() + self.cancel_timeout
        self.cancel_future = self.goal_handle.cancel_goal_async()
        self.cancel_future.add_done_callback(self._on_cancel_response)

    def _on_cancel_response(self, future):
        try:
            response = future.result()
            if not response.goals_canceling:
                self.estop_request_publisher.publish(Bool(data=True))
                self._publish("FAILED", "Nav2 did not acknowledge cancellation")
        except Exception as exc:
            self.estop_request_publisher.publish(Bool(data=True))
            self._publish("FAILED", f"navigation cancellation failed: {exc}")

    def _finish(self, state, reason, exit_code):
        if self.exit_code is not None:
            return
        self.exit_code = exit_code
        self._publish(state, reason)

    def request_shutdown(self):
        if self.shutdown_requested:
            return
        self.shutdown_requested = True
        self.estop_request_publisher.publish(Bool(data=True))
        self._cancel("mission shutdown")


def main(args=None):
    rclpy.init(args=args)
    node = NavigateGoal()

    def stop_handler(_signum, _frame):
        node.request_shutdown()

    previous = {
        signum: signal.signal(signum, stop_handler)
        for signum in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        rclpy.spin(node)
    finally:
        node.request_shutdown()
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        exit_code = node.exit_code if node.exit_code is not None else 130
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
