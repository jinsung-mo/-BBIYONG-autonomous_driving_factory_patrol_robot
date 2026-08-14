#!/usr/bin/env python3
"""Translate the existing atomic manual-drive file into the mux manual input."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import time

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String


class ManualDriveBridge(Node):
    """Fail-safe file adapter; command ownership remains with bbiyong_cmd_mux."""

    def __init__(self) -> None:
        super().__init__("bbiyong_manual_drive_bridge")
        self.declare_parameter("command_file", "/tmp/orincar_drive.json")
        self.declare_parameter("status_file", "/tmp/orincar_drive_status.json")
        self.declare_parameter("scan_topic", "/scan_filtered")
        self.declare_parameter("publish_rate_hz", 20.0)
        self.declare_parameter("deadman_timeout_sec", 0.4)
        self.declare_parameter("max_linear_speed", 1.0)
        self.declare_parameter("max_angular_speed", 0.6)
        self.declare_parameter("linear_acceleration", 0.5)
        self.declare_parameter("obstacle_stop_distance", 0.25)
        self.declare_parameter("obstacle_cone_half_angle_deg", 40.0)

        self.command_file = Path(
            str(self.get_parameter("command_file").value)
        ).expanduser()
        self.status_file = Path(
            str(self.get_parameter("status_file").value)
        ).expanduser()
        self.rate = float(self.get_parameter("publish_rate_hz").value)
        self.deadman = float(self.get_parameter("deadman_timeout_sec").value)
        self.max_linear = float(self.get_parameter("max_linear_speed").value)
        self.max_angular = float(self.get_parameter("max_angular_speed").value)
        self.acceleration = float(self.get_parameter("linear_acceleration").value)
        self.stop_distance = float(
            self.get_parameter("obstacle_stop_distance").value
        )
        self.cone_half_angle = math.radians(
            float(self.get_parameter("obstacle_cone_half_angle_deg").value)
        )
        if min(
            self.rate,
            self.deadman,
            self.max_linear,
            self.max_angular,
            self.acceleration,
            self.stop_distance,
        ) <= 0.0:
            raise ValueError("manual drive limits and timeouts must be positive")

        self.scan: LaserScan | None = None
        self.linear_output = 0.0
        self.last_reason = ""
        self.publisher = self.create_publisher(Twist, "/cmd_vel/manual", 10)
        self.status_publisher = self.create_publisher(
            String, "/bbiyong/manual_drive_status", 10
        )
        self.create_subscription(
            LaserScan,
            str(self.get_parameter("scan_topic").value),
            self._on_scan,
            qos_profile_sensor_data,
        )
        self.create_timer(1.0 / self.rate, self._tick)
        self.get_logger().info(
            f"manual commands {self.command_file} -> /cmd_vel/manual; "
            f"deadman={self.deadman:.2f}s"
        )

    def _on_scan(self, message: LaserScan) -> None:
        self.scan = message

    def _read_command(self):
        try:
            return json.loads(self.command_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _blocked(self, linear: float) -> bool:
        if abs(linear) <= 1e-4 or self.scan is None:
            return False
        heading = 0.0 if linear > 0.0 else math.pi
        message = self.scan
        for index, distance in enumerate(message.ranges):
            if not math.isfinite(distance):
                continue
            if distance <= message.range_min or distance >= message.range_max:
                continue
            angle = message.angle_min + index * message.angle_increment
            delta = math.atan2(
                math.sin(angle - heading), math.cos(angle - heading)
            )
            if abs(delta) <= self.cone_half_angle and distance < self.stop_distance:
                return True
        return False

    def _ramp(self, requested: float) -> float:
        maximum_step = self.acceleration / self.rate
        difference = requested - self.linear_output
        if abs(difference) <= maximum_step:
            return requested
        return self.linear_output + math.copysign(maximum_step, difference)

    def _tick(self) -> None:
        now = time.time()
        command = self._read_command()
        requested_linear = 0.0
        requested_angular = 0.0
        reason = "idle"
        fail_safe = True

        if command is None:
            reason = "command unavailable"
        elif command.get("armed") is not True:
            reason = "disarmed"
        else:
            try:
                age = now - float(command.get("ts", 0.0))
                requested_linear = float(command.get("v", 0.0))
                requested_angular = float(command.get("w", 0.0))
            except (TypeError, ValueError):
                reason = "invalid command"
            else:
                if not all(
                    math.isfinite(value)
                    for value in (age, requested_linear, requested_angular)
                ):
                    reason = "non-finite command"
                elif age < -1.0 or age > self.deadman:
                    reason = f"deadman timeout ({age:.2f}s)"
                else:
                    fail_safe = False
                    requested_linear = max(
                        -self.max_linear, min(self.max_linear, requested_linear)
                    )
                    requested_angular = max(
                        -self.max_angular, min(self.max_angular, requested_angular)
                    )
                    reason = "manual command"

        if fail_safe:
            self.linear_output = 0.0
            linear = angular = 0.0
        else:
            linear = self._ramp(requested_linear)
            angular = requested_angular
            if self._blocked(linear):
                linear = 0.0
                reason = "obstacle stop"
            self.linear_output = linear

        twist = Twist()
        twist.linear.x = linear
        twist.angular.z = angular
        self.publisher.publish(twist)

        status = {
            "t": now,
            "v": linear,
            "w": angular,
            "reason": reason,
            "v_max": self.max_linear,
            "w_max": self.max_angular,
            "stop_m": self.stop_distance,
            "patrol_running": False,
        }
        self.status_publisher.publish(String(data=json.dumps(status)))
        temporary = self.status_file.with_name(self.status_file.name + ".tmp")
        try:
            self.status_file.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(status), encoding="utf-8")
            os.replace(temporary, self.status_file)
        except OSError:
            pass
        if reason != self.last_reason:
            self.last_reason = reason
            self.get_logger().info(
                f"manual state: {reason}; v={linear:.3f} w={angular:.3f}"
            )

    def stop(self) -> None:
        self.publisher.publish(Twist())


def main(args=None) -> None:
    rclpy.init(args=args)
    node = ManualDriveBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if rclpy.ok(context=node.context):
                node.stop()
        except Exception:
            pass
        try:
            node.destroy_node()
        except (KeyboardInterrupt, Exception):
            pass
        try:
            rclpy.try_shutdown()
        except (KeyboardInterrupt, Exception):
            pass


if __name__ == "__main__":
    main()
