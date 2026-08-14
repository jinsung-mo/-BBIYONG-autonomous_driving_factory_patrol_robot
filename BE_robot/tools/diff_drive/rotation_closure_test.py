#!/usr/bin/env python3
"""Run a low-speed left/right 360-degree odometry closure test."""

import math
import time

import rclpy
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy


class RotationClosureTest(Node):
    def __init__(self):
        super().__init__("rotation_closure_test")
        qos = QoSProfile(reliability=ReliabilityPolicy.RELIABLE, depth=10)
        self.publisher = self.create_publisher(Twist, "/cmd_vel", 10)
        self.create_subscription(Odometry, "/odom", self.on_odom, qos)
        self.pose = None

    def on_odom(self, message):
        q = message.pose.pose.orientation
        yaw = math.atan2(
            2.0 * (q.w * q.z + q.x * q.y),
            1.0 - 2.0 * (q.y * q.y + q.z * q.z),
        )
        position = message.pose.pose.position
        self.pose = position.x, position.y, yaw

    def send(self, angular_z):
        message = Twist()
        message.angular.z = angular_z
        self.publisher.publish(message)

    def stop(self):
        for _ in range(10):
            self.send(0.0)
            rclpy.spin_once(self, timeout_sec=0.02)
            time.sleep(0.03)

    def wait_for_odom(self, timeout_sec=5.0):
        deadline = time.monotonic() + timeout_sec
        while self.pose is None and time.monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.1)
        if self.pose is None:
            raise RuntimeError("no /odom received")

    def rotate(self, label, direction, speed=0.25, timeout_sec=45.0):
        start_x, start_y, previous_yaw = self.pose
        accumulated_yaw = 0.0
        deadline = time.monotonic() + timeout_sec
        target = direction * 2.0 * math.pi
        while direction * accumulated_yaw < 2.0 * math.pi:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"{label} rotation timed out")
            self.send(direction * speed)
            rclpy.spin_once(self, timeout_sec=0.04)
            if self.pose is None:
                continue
            _, _, yaw = self.pose
            delta = math.atan2(
                math.sin(yaw - previous_yaw),
                math.cos(yaw - previous_yaw),
            )
            accumulated_yaw += delta
            previous_yaw = yaw
        self.stop()
        end_x, end_y, _ = self.pose
        translation = math.hypot(end_x - start_x, end_y - start_y)
        print(
            f"{label}: yaw={math.degrees(accumulated_yaw):+.2f} deg "
            f"target={math.degrees(target):+.1f} deg "
            f"translation={translation:.4f} m "
            f"start=({start_x:.4f},{start_y:.4f}) "
            f"end=({end_x:.4f},{end_y:.4f})",
            flush=True,
        )


def main():
    rclpy.init()
    node = RotationClosureTest()
    try:
        node.wait_for_odom()
        initial = node.pose
        node.rotate("left", 1.0)
        print("pause: 3.0 s", flush=True)
        end_pause = time.monotonic() + 3.0
        while time.monotonic() < end_pause:
            node.send(0.0)
            rclpy.spin_once(node, timeout_sec=0.05)
        node.rotate("right", -1.0)
        node.stop()
        final = node.pose
        closure = math.hypot(final[0] - initial[0], final[1] - initial[1])
        yaw_closure = math.degrees(
            math.atan2(
                math.sin(final[2] - initial[2]),
                math.cos(final[2] - initial[2]),
            )
        )
        print(
            f"closure: translation={closure:.4f} m "
            f"yaw={yaw_closure:+.2f} deg "
            f"initial=({initial[0]:.4f},{initial[1]:.4f}) "
            f"final=({final[0]:.4f},{final[1]:.4f})",
            flush=True,
        )
    finally:
        node.stop()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
