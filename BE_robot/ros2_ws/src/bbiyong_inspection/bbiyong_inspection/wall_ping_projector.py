#!/usr/bin/env python3
"""Project camera rays onto a 2D occupancy map and propose safe viewpoints."""

from __future__ import annotations

import math
import time
import uuid

import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rclpy.time import Time
from std_msgs.msg import String
from tf2_ros import Buffer, TransformException, TransformListener

from .geometry import GridMap, normalize2, quaternion_rotate
from .protocol import decode_object, encode_object, finite_number


def yaw_from_quaternion(quaternion):
    return math.atan2(
        2.0 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y),
        1.0 - 2.0 * (quaternion.y * quaternion.y + quaternion.z * quaternion.z),
    )


class WallPingProjector(Node):
    def __init__(self):
        super().__init__("bbiyong_wall_ping_projector")
        self.declare_parameter("detections_topic", "/apriltag/detections")
        self.declare_parameter("manual_target_topic", "/inspection/manual_target")
        self.declare_parameter("candidate_topic", "/inspection/candidates")
        self.declare_parameter("status_topic", "/inspection/projector_status")
        self.declare_parameter("map_topic", "/map")
        self.declare_parameter("map_frame", "map")
        self.declare_parameter("base_frame", "base_link")
        self.declare_parameter("map_id", "active-map")
        self.declare_parameter("max_ray_range_m", 8.0)
        self.declare_parameter("occupied_threshold", 65)
        self.declare_parameter("stand_off_m", 0.8)
        self.declare_parameter("robot_clearance_m", 0.32)
        self.declare_parameter("lateral_search_m", 0.8)
        self.declare_parameter("manual_snap_radius_m", 0.30)
        self.declare_parameter("tf_timeout_sec", 0.20)
        self.declare_parameter("candidate_publish_period_sec", 0.5)

        self.map_frame = str(self.get_parameter("map_frame").value)
        self.base_frame = str(self.get_parameter("base_frame").value)
        self.map_id = str(self.get_parameter("map_id").value)
        self.max_range = float(self.get_parameter("max_ray_range_m").value)
        self.occupied_threshold = int(self.get_parameter("occupied_threshold").value)
        self.stand_off = float(self.get_parameter("stand_off_m").value)
        self.clearance = float(self.get_parameter("robot_clearance_m").value)
        self.lateral_search = float(self.get_parameter("lateral_search_m").value)
        self.manual_snap_radius = float(
            self.get_parameter("manual_snap_radius_m").value
        )
        self.tf_timeout = float(self.get_parameter("tf_timeout_sec").value)
        self.publish_period = float(
            self.get_parameter("candidate_publish_period_sec").value
        )
        if min(self.max_range, self.stand_off, self.clearance, self.tf_timeout) <= 0.0:
            raise ValueError("range, stand-off, clearance, and TF timeout must be positive")

        self.grid = None
        self.last_published = {}
        self.tf_buffer = Buffer(cache_time=Duration(seconds=10.0))
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self.candidate_publisher = self.create_publisher(
            String, str(self.get_parameter("candidate_topic").value), 10
        )
        self.status_publisher = self.create_publisher(
            String, str(self.get_parameter("status_topic").value), 10
        )
        map_qos = QoSProfile(
            depth=1,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            reliability=ReliabilityPolicy.RELIABLE,
        )
        self.create_subscription(
            OccupancyGrid,
            str(self.get_parameter("map_topic").value),
            self._on_map,
            map_qos,
        )
        self.create_subscription(
            String,
            str(self.get_parameter("detections_topic").value),
            self._on_detections,
            10,
        )
        self.create_subscription(
            String,
            str(self.get_parameter("manual_target_topic").value),
            self._on_manual_target,
            10,
        )
        self.create_timer(2.0, self._publish_status)
        self._publish_status()

    def _publish_status(self, reason=""):
        state = "READY" if self.grid is not None else "WAITING_FOR_MAP"
        if self.grid is None and not reason:
            reason = "waiting for OccupancyGrid"
        self.status_publisher.publish(String(data=encode_object(
            "projector_status", state=state, reason=reason, mapId=self.map_id
        )))

    def _on_map(self, message):
        origin = message.info.origin
        try:
            self.grid = GridMap(
                message.info.width,
                message.info.height,
                message.info.resolution,
                origin.position.x,
                origin.position.y,
                yaw_from_quaternion(origin.orientation),
                message.data,
            )
        except ValueError as exc:
            self.grid = None
            self.get_logger().error(f"ignored invalid occupancy map: {exc}")

    def _lookup(self, source_frame, stamp):
        sec = int(stamp.get("sec", 0))
        nanosec = int(stamp.get("nanosec", 0))
        when = Time(seconds=sec, nanoseconds=nanosec) if sec or nanosec else Time()
        return self.tf_buffer.lookup_transform(
            self.map_frame,
            source_frame,
            when,
            timeout=Duration(seconds=self.tf_timeout),
        )

    def _candidate(self, candidate_id, source, target, direction, confidence, **extra):
        viewpoint = self.grid.viewpoint_for_target(
            (target["x"], target["y"]),
            direction,
            self.stand_off,
            self.clearance,
            lateral_search_m=self.lateral_search,
        )
        if viewpoint is None:
            raise ValueError("no collision-free viewpoint was found")
        now = time.time()
        candidate = {
            "candidateId": candidate_id,
            "source": source,
            "mapId": self.map_id,
            "target": {"x": float(target["x"]), "y": float(target["y"])},
            "viewpoint": {
                "x": float(viewpoint["x"]),
                "y": float(viewpoint["y"]),
                "yaw": float(viewpoint["yaw"]),
            },
            "standOffM": float(viewpoint["standOffM"]),
            "confidence": max(0.0, min(1.0, float(confidence))),
            "createdAt": now,
            **extra,
        }
        last = self.last_published.get(candidate_id, 0.0)
        if now - last >= self.publish_period:
            self.last_published[candidate_id] = now
            self.candidate_publisher.publish(
                String(data=encode_object("inspection_candidate", candidate=candidate))
            )

    def _on_detections(self, message):
        if self.grid is None:
            return
        try:
            payload = decode_object(message.data, kind="apriltag_detections")
            source_frame = str(payload.get("frameId", "")).strip()
            if not source_frame:
                raise ValueError("detection frameId is required")
            transform = self._lookup(source_frame, payload.get("stamp", {}))
            translation = transform.transform.translation
            rotation = transform.transform.rotation
            quaternion = (rotation.x, rotation.y, rotation.z, rotation.w)
            origin = (translation.x, translation.y, translation.z)
            detections = payload.get("detections", [])
            if not isinstance(detections, list):
                raise ValueError("detections must be a list")
            for raw in detections:
                try:
                    tag_id = int(raw.get("tagId"))
                    ray = raw.get("ray")
                    if not isinstance(ray, list) or len(ray) != 3:
                        raise ValueError("ray must contain three values")
                    camera_ray = tuple(finite_number(v, "ray") for v in ray)
                    map_ray = quaternion_rotate(camera_ray, quaternion)
                    direction = normalize2(map_ray[0], map_ray[1])
                    hit, reason = self.grid.raycast(
                        origin,
                        direction,
                        self.max_range,
                        occupied_threshold=self.occupied_threshold,
                    )
                    if hit is None:
                        self.get_logger().debug(f"tag {tag_id} not projected: {reason}")
                        continue
                    self._candidate(
                        f"tag-{self.map_id}-{tag_id}",
                        "APRILTAG",
                        hit,
                        direction,
                        raw.get("confidence", 0.0),
                        tagId=tag_id,
                        rayOrigin={"x": origin[0], "y": origin[1]},
                    )
                except (TypeError, ValueError) as exc:
                    self.get_logger().warning(f"ignored invalid tag detection: {exc}")
        except (ValueError, TransformException) as exc:
            self.get_logger().warning(f"could not project detections: {exc}")

    def _nearest_occupied(self, x, y):
        center_col, center_row = self.grid.world_to_cell(x, y)
        radius = max(0, math.ceil(self.manual_snap_radius / self.grid.resolution))
        best = None
        for row in range(center_row - radius, center_row + radius + 1):
            for col in range(center_col - radius, center_col + radius + 1):
                value = self.grid.occupancy(col, row)
                if value is None or value < self.occupied_threshold:
                    continue
                wx, wy = self.grid.cell_to_world(col, row)
                distance = math.hypot(wx - x, wy - y)
                if distance <= self.manual_snap_radius and (
                    best is None or distance < best[0]
                ):
                    best = (distance, wx, wy)
        return None if best is None else {"x": best[1], "y": best[2]}

    def _on_manual_target(self, message):
        if self.grid is None:
            return
        try:
            payload = decode_object(message.data, kind="manual_target")
            x = finite_number(payload.get("x"), "x")
            y = finite_number(payload.get("y"), "y")
            target = self._nearest_occupied(x, y)
            if target is None:
                raise ValueError("manual target is not close to an occupied map cell")
            transform = self._lookup(self.base_frame, {})
            base = transform.transform.translation
            direction = normalize2(target["x"] - base.x, target["y"] - base.y)
            request_id = str(payload.get("requestId", uuid.uuid4().hex))[:128]
            self._candidate(
                f"manual-{request_id}",
                "MANUAL",
                target,
                direction,
                1.0,
            )
        except (ValueError, TransformException) as exc:
            self.get_logger().warning(f"could not project manual target: {exc}")


def main(args=None):
    rclpy.init(args=args)
    node = WallPingProjector()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    main()
