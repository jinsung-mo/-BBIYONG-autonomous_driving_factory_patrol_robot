#!/usr/bin/env python3
"""Fail-closed readiness and authority guard for saved-map scouting."""

from __future__ import annotations

import math
import json
from pathlib import Path
import time
import uuid

from geometry_msgs.msg import PoseWithCovarianceStamped
from lifecycle_msgs.srv import GetState
import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from rclpy.time import Time
from std_msgs.msg import Bool, String
from tf2_msgs.msg import TFMessage
from tf2_ros import Buffer, TransformListener

from .scouting_session import atomic_write_json


LIFECYCLE_NODES = (
    "map_server",
    "amcl",
    "controller_server",
    "planner_server",
    "behavior_server",
    "bt_navigator",
    "waypoint_follower",
    "velocity_smoother",
    "collision_slowdown_monitor",
    "collision_monitor",
)


class ScoutingGuard(Node):
    def __init__(self):
        super().__init__("bbiyong_scouting_guard")
        self.declare_parameter("map_file", "")
        self.declare_parameter("state_file", "/tmp/bbiyong_scouting_session.json")
        self.declare_parameter("readiness_timeout_sec", 90.0)
        self.declare_parameter("authority_settle_sec", 2.0)
        self.map_file = str(Path(str(self.get_parameter("map_file").value)).expanduser())
        self.state_file = Path(str(self.get_parameter("state_file").value)).expanduser()
        self.timeout = float(self.get_parameter("readiness_timeout_sec").value)
        self.settle = float(self.get_parameter("authority_settle_sec").value)
        if not self.map_file or min(self.timeout, self.settle) <= 0.0:
            raise ValueError("map_file and positive readiness limits are required")

        self.session_id = uuid.uuid4().hex
        self.started = time.monotonic()
        self.ready_since = None
        self.ready = False
        self.failed = False
        self.last_heartbeat = 0.0
        self.pose_valid = False
        self.map_odom_publishers = {}
        self.lifecycle = {name: False for name in LIFECYCLE_NODES}
        self.lifecycle_futures = {}
        self.lifecycle_clients = {
            name: self.create_client(GetState, f"/{name}/get_state")
            for name in LIFECYCLE_NODES
        }
        self.ready_publisher = self.create_publisher(
            Bool, "/bbiyong/scouting/ready", 10
        )
        self.state_publisher = self.create_publisher(
            String, "/bbiyong/scouting/state", 10
        )
        self.estop_request_publisher = self.create_publisher(
            Bool, "/bbiyong/estop_request", 10
        )
        self.create_subscription(
            PoseWithCovarianceStamped,
            "/amcl_pose",
            self._on_pose,
            qos_profile_sensor_data,
        )
        self.create_subscription(TFMessage, "/tf", self._on_tf, qos_profile_sensor_data)
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self._persist("WAITING", "initial pose and authorities are not ready")
        self.create_timer(0.25, self._tick)

    def _payload(self, state, reason):
        return {
            "schemaVersion": 1,
            "sessionId": self.session_id,
            "mapFile": self.map_file,
            "ready": self.ready,
            "state": state,
            "reason": reason,
            "updatedAt": time.time(),
        }

    def _persist(self, state, reason):
        payload = self._payload(state, reason)
        atomic_write_json(self.state_file, payload)
        try:
            self.ready_publisher.publish(Bool(data=self.ready))
            self.state_publisher.publish(String(data=json.dumps(payload)))
        except Exception:
            # The atomic state file is authoritative during context shutdown.
            pass

    def _on_pose(self, message):
        values = [
            message.pose.pose.position.x,
            message.pose.pose.position.y,
            message.pose.pose.orientation.x,
            message.pose.pose.orientation.y,
            message.pose.pose.orientation.z,
            message.pose.pose.orientation.w,
            *message.pose.covariance,
        ]
        orientation = message.pose.pose.orientation
        quaternion_norm = math.sqrt(
            orientation.x ** 2
            + orientation.y ** 2
            + orientation.z ** 2
            + orientation.w ** 2
        )
        self.pose_valid = (
            all(math.isfinite(value) for value in values)
            and quaternion_norm > 0.5
        )

    def _on_tf(self, message, info):
        publisher = bytes(info.publisher_gid).hex()
        now = time.monotonic()
        for transform in message.transforms:
            parent = transform.header.frame_id.lstrip("/")
            child = transform.child_frame_id.lstrip("/")
            if parent == "map" and child == "odom":
                self.map_odom_publishers[publisher] = now

    def _request_lifecycle_states(self):
        for name, client in self.lifecycle_clients.items():
            future = self.lifecycle_futures.get(name)
            if future is not None and not future.done():
                continue
            if not client.service_is_ready():
                self.lifecycle[name] = False
                continue
            future = client.call_async(GetState.Request())
            self.lifecycle_futures[name] = future
            future.add_done_callback(
                lambda completed, node_name=name: self._on_lifecycle(node_name, completed)
            )

    def _on_lifecycle(self, name, future):
        try:
            self.lifecycle[name] = future.result().current_state.label == "active"
        except Exception:
            self.lifecycle[name] = False

    def _fail(self, reason):
        if self.failed:
            return
        self.failed = True
        self.ready = False
        self.estop_request_publisher.publish(Bool(data=True))
        self._persist("FAILED", reason)
        self.get_logger().error(reason)
        if rclpy.ok(context=self.context):
            rclpy.shutdown(context=self.context)

    def _tick(self):
        node_names = {name for name, _namespace in self.get_node_names_and_namespaces()}
        if "slam_toolbox" in node_names or "async_slam_toolbox_node" in node_names:
            self._fail("slam_toolbox must be stopped by its session owner")
            return
        self._request_lifecycle_states()
        publishers = self.get_publishers_info_by_topic("/map")
        now = time.monotonic()
        self.map_odom_publishers = {
            publisher: seen
            for publisher, seen in self.map_odom_publishers.items()
            if now - seen <= 2.0
        }
        try:
            transform_ready = self.tf_buffer.can_transform(
                "map", "base_link", Time(), timeout=Duration(seconds=0.05)
            )
        except Exception:
            transform_ready = False
        conditions = (
            len(publishers) == 1
            and publishers[0].node_name.lstrip("/") == "map_server",
            len(self.map_odom_publishers) == 1,
            self.pose_valid,
            transform_ready,
            all(self.lifecycle.values()),
        )
        if all(conditions):
            if self.ready_since is None:
                self.ready_since = now
            if not self.ready and now - self.ready_since >= self.settle:
                self.ready = True
                self._persist("READY", "")
                self.get_logger().info(
                    f"scouting ready for {self.map_file}; reapply patrol route"
                )
            if self.ready and now - self.last_heartbeat >= 1.0:
                self.last_heartbeat = now
                self._persist("READY", "")
            return
        self.ready_since = None
        if self.ready:
            self._fail("scouting authority or localization readiness was lost")
            return
        if now - self.started >= self.timeout:
            missing = []
            if len(publishers) != 1 or (
                publishers
                and publishers[0].node_name.lstrip("/") != "map_server"
            ):
                owners = [publisher.node_name for publisher in publishers]
                missing.append(f"/map publishers={owners}")
            if len(self.map_odom_publishers) != 1:
                missing.append(f"map->odom authorities={len(self.map_odom_publishers)}")
            if not self.pose_valid:
                missing.append("valid /amcl_pose")
            if not transform_ready:
                missing.append("map->base_link TF")
            inactive = [name for name, active in self.lifecycle.items() if not active]
            if inactive:
                missing.append("inactive lifecycle nodes=" + ",".join(inactive))
            self._fail("scouting readiness timeout: " + "; ".join(missing))


def main(args=None):
    rclpy.init(args=args)
    node = ScoutingGuard()
    try:
        rclpy.spin(node)
    finally:
        if not node.failed:
            node.ready = False
            node._persist("STOPPED", "scouting runtime stopped")
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()
    raise SystemExit(1 if node.failed else 0)


if __name__ == "__main__":
    main()
