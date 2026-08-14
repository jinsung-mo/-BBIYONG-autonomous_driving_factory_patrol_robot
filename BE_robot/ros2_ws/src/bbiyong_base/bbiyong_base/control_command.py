"""Confirmed operator arm/stop commands through the persistent state bridge."""

from __future__ import annotations

import sys

import rclpy
from rclpy.node import Node
from std_srvs.srv import SetBool, Trigger


class ControlCommand(Node):
    def __init__(self) -> None:
        super().__init__("bbiyong_control_command")
        self.autonomy_client = self.create_client(
            SetBool, "/bbiyong/set_autonomy"
        )
        self.manual_client = self.create_client(
            Trigger, "/bbiyong/set_manual"
        )

    def _request(self, arm: bool, timeout_sec: float) -> bool:
        action = "arm autonomy" if arm else "stop"
        if not self.autonomy_client.wait_for_service(timeout_sec=timeout_sec):
            self.get_logger().error(
                f"{action} refused: control-state bridge service unavailable"
            )
            return False

        request = SetBool.Request()
        request.data = arm
        future = self.autonomy_client.call_async(request)
        rclpy.spin_until_future_complete(self, future, timeout_sec=timeout_sec)
        if not future.done():
            self.get_logger().error(
                f"{action} failed: control-state bridge confirmation timed out"
            )
            return False
        try:
            response = future.result()
        except Exception as exc:
            self.get_logger().error(f"{action} failed: {exc}")
            return False
        if response is None or not response.success:
            message = "no response" if response is None else response.message
            self.get_logger().error(f"{action} refused: {message}")
            return False
        self.get_logger().info(response.message)
        return True

    def arm(self) -> bool:
        return self._request(True, 20.0)

    def stop(self) -> bool:
        return self._request(False, 5.0)

    def manual(self) -> bool:
        timeout_sec = 5.0
        if not self.manual_client.wait_for_service(timeout_sec=timeout_sec):
            self.get_logger().error(
                "manual refused: control-state bridge service unavailable"
            )
            return False

        future = self.manual_client.call_async(Trigger.Request())
        rclpy.spin_until_future_complete(self, future, timeout_sec=timeout_sec)
        if not future.done():
            self.get_logger().error(
                "manual failed: control-state bridge confirmation timed out"
            )
            return False
        try:
            response = future.result()
        except Exception as exc:
            self.get_logger().error(f"manual failed: {exc}")
            return False
        if response is None or not response.success:
            message = "no response" if response is None else response.message
            self.get_logger().error(f"manual refused: {message}")
            return False
        self.get_logger().info(response.message)
        return True


def main(args=None) -> None:
    command_args = sys.argv[1:] if args is None else args
    if len(command_args) != 1 or command_args[0] not in {"arm", "manual", "stop"}:
        print(
            "usage: ros2 run bbiyong_base control_command {arm|manual|stop}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    rclpy.init()
    node = ControlCommand()
    try:
        if command_args[0] == "arm":
            success = node.arm()
        elif command_args[0] == "manual":
            success = node.manual()
        else:
            success = node.stop()
        if not success:
            raise SystemExit(1)
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
