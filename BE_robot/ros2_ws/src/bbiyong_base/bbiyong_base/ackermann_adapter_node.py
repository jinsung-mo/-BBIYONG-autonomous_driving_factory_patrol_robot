from math import radians

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, Float64

from .kinematics import VehicleLimits, twist_to_ackermann
from .safety import CommandWatchdog


class AckermannAdapter(Node):
    """Safe ROS-side adapter. Hardware-specific PWM/I2C code is intentionally separate."""

    def __init__(self) -> None:
        super().__init__("bbiyong_ackermann_adapter")
        self.declare_parameter("hardware_enabled", False)
        self.declare_parameter("wheelbase_m", 0.0)
        self.declare_parameter("max_steering_angle_deg", 0.0)
        self.declare_parameter("max_linear_speed_mps", 0.1)
        self.declare_parameter("max_angular_speed_rps", 0.3)
        self.declare_parameter("throttle_direction", 1.0)
        self.declare_parameter("steering_direction", 1.0)
        self.declare_parameter("cmd_timeout_sec", 0.35)

        self.hardware_enabled = bool(self.get_parameter("hardware_enabled").value)
        self.limits = VehicleLimits(
            wheelbase_m=float(self.get_parameter("wheelbase_m").value),
            max_steering_angle_rad=radians(float(self.get_parameter("max_steering_angle_deg").value)),
            max_linear_speed_mps=float(self.get_parameter("max_linear_speed_mps").value),
            max_angular_speed_rps=float(self.get_parameter("max_angular_speed_rps").value),
            throttle_direction=float(self.get_parameter("throttle_direction").value),
            steering_direction=float(self.get_parameter("steering_direction").value),
        )
        if self.hardware_enabled:
            self.limits.validate()
        timeout = float(self.get_parameter("cmd_timeout_sec").value)
        if timeout <= 0.0:
            raise ValueError("cmd_timeout_sec must be positive")
        self.watchdog = CommandWatchdog(timeout)
        self.estop = True
        self.last_twist = Twist()
        # (S15P11E101-801) 발행자(control_state_bridge.py)는 TRANSIENT_LOCAL 로 마지막
        # 상태를 래치해 보낸다 — 순정수(10)면 기본 QoS인 VOLATILE 이 되어 래치된 값을
        # 못 받고 재시작 시 몇 초~몇십 초간 estop=True 에 갇힌다(exploration_node.py
        # 에서 실기 확인된 것과 같은 버그).
        self.throttle_pub = self.create_publisher(Float64, "/bbiyong/actuator/throttle", 10)
        self.steering_pub = self.create_publisher(Float64, "/bbiyong/actuator/steering_angle_rad", 10)
        self.create_subscription(Twist, "/cmd_vel", self._twist_callback, 10)
        self.create_subscription(Bool, "/bbiyong/estop", self._estop_callback, CONTROL_STATE_QOS)
        self.create_timer(0.05, self._tick)
        if not self.hardware_enabled:
            self.get_logger().warn("hardware_enabled=false: actuator outputs are forced to zero")

    def _now(self) -> float:
        return self.get_clock().now().nanoseconds / 1e9

    def _twist_callback(self, message: Twist) -> None:
        self.last_twist = message
        self.watchdog.record(self._now())

    def _estop_callback(self, message: Bool) -> None:
        self.estop = bool(message.data)
        if self.estop:
            self._publish_stop()

    def _publish_stop(self) -> None:
        self.throttle_pub.publish(Float64(data=0.0))
        self.steering_pub.publish(Float64(data=0.0))

    def _tick(self) -> None:
        if not self.hardware_enabled or self.estop or self.watchdog.expired(self._now()):
            self._publish_stop()
            return
        command = twist_to_ackermann(
            self.last_twist.linear.x,
            self.last_twist.angular.z,
            self.limits,
        )
        if command.rejected_in_place_rotation:
            self.get_logger().warn("rejected in-place rotation for Ackermann drive", throttle_duration_sec=2.0)
        self.throttle_pub.publish(Float64(data=command.throttle))
        self.steering_pub.publish(Float64(data=command.steering_angle_rad))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = AckermannAdapter()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if rclpy.ok(context=node.context):
                node._publish_stop()
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
