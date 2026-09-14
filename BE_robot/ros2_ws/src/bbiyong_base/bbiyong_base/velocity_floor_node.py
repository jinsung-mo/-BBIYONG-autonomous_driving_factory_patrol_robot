"""Enforce a usable minimum angular command for deliberate in-place turns."""

from __future__ import annotations

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node

from .velocity_floor import enforce_in_place_rotation_floor


class VelocityFloor(Node):
    def __init__(self) -> None:
        super().__init__("bbiyong_velocity_floor")
        self.declare_parameter("input_topic", "/cmd_vel/autonomy_unfloored")
        self.declare_parameter("output_topic", "/cmd_vel/autonomy_raw")
        self.declare_parameter("minimum_angular_speed", 0.42)
        self.declare_parameter("minimum_input_angular_speed", 0.05)
        self.declare_parameter("linear_epsilon", 0.01)

        self.minimum_angular_speed = float(
            self.get_parameter("minimum_angular_speed").value
        )
        self.minimum_input_angular_speed = float(
            self.get_parameter("minimum_input_angular_speed").value
        )
        self.linear_epsilon = float(self.get_parameter("linear_epsilon").value)
        if not (
            0.0
            < self.minimum_input_angular_speed
            <= self.minimum_angular_speed
            and self.linear_epsilon >= 0.0
        ):
            raise ValueError("invalid velocity-floor thresholds")

        self.publisher = self.create_publisher(
            Twist, str(self.get_parameter("output_topic").value), 10
        )
        self.create_subscription(
            Twist,
            str(self.get_parameter("input_topic").value),
            self._on_command,
            10,
        )

    def _on_command(self, message: Twist) -> None:
        linear_x, angular_z = enforce_in_place_rotation_floor(
            message.linear.x,
            message.angular.z,
            minimum_angular_speed=self.minimum_angular_speed,
            minimum_input_angular_speed=self.minimum_input_angular_speed,
            linear_epsilon=self.linear_epsilon,
        )
        output = Twist()
        output.linear.x = linear_x
        output.linear.y = message.linear.y
        output.linear.z = message.linear.z
        output.angular.x = message.angular.x
        output.angular.y = message.angular.y
        output.angular.z = angular_z
        self.publisher.publish(output)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = VelocityFloor()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if rclpy.ok(context=node.context):
                node.publisher.publish(Twist())
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
