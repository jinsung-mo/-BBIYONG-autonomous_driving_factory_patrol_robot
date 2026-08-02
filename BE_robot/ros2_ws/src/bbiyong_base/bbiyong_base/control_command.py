"""Atomic operator arm/stop commands for the BBIYONG command mux."""

from __future__ import annotations

import sys
from time import monotonic

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from std_msgs.msg import Bool, String


class ControlCommand(Node):
    def __init__(self) -> None:
        super().__init__("bbiyong_control_command")
        self.mode_publisher = self.create_publisher(
            String, "/bbiyong/control_mode", 10
        )
        self.estop_publisher = self.create_publisher(Bool, "/bbiyong/estop", 10)
        self.cmd_vel_publisher = self.create_publisher(Twist, "/cmd_vel", 10)

    def wait_for_arm_subscribers(self, timeout_sec: float) -> bool:
        """Require both the mux and explorer before publishing any arm state."""
        deadline = monotonic() + timeout_sec
        while monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.1)
            if (
                self.mode_publisher.get_subscription_count() >= 2
                and self.estop_publisher.get_subscription_count() >= 2
            ):
                return True
        return False

    def arm(self) -> bool:
        if not self.wait_for_arm_subscribers(20.0):
            self.get_logger().error(
                "Arm refused: command mux and frontier explorer were not both discovered"
            )
            return False
        mode = String(data="autonomy")
        released = Bool(data=False)
        for _ in range(20):
            self.mode_publisher.publish(mode)
            self.estop_publisher.publish(released)
            rclpy.spin_once(self, timeout_sec=0.1)
        self.get_logger().info("Nav2 autonomy armed")
        return True

    def stop(self) -> None:
        stopped = Bool(data=True)
        disabled = String(data="disabled")
        zero = Twist()
        for _ in range(20):
            self.estop_publisher.publish(stopped)
            self.mode_publisher.publish(disabled)
            self.cmd_vel_publisher.publish(zero)
            rclpy.spin_once(self, timeout_sec=0.05)
        self.get_logger().warning("software emergency stop sent")


def main(args=None) -> None:
    command_args = sys.argv[1:] if args is None else args
    if len(command_args) != 1 or command_args[0] not in {"arm", "stop"}:
        print("usage: ros2 run bbiyong_base control_command {arm|stop}", file=sys.stderr)
        raise SystemExit(2)

    rclpy.init()
    node = ControlCommand()
    try:
        if command_args[0] == "arm":
            if not node.arm():
                raise SystemExit(1)
        else:
            node.stop()
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
