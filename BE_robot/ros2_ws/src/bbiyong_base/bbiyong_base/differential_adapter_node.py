import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, Float64

from .kinematics import VehicleLimits, twist_to_differential
from .safety import CommandWatchdog


class DifferentialAdapter(Node):
    """Safe ROS-side adapter. Hardware-specific PWM/I2C code is intentionally separate."""

    def __init__(self) -> None:
        super().__init__("bbiyong_differential_adapter")
        self.declare_parameter("hardware_enabled", False)
        # 0.0 means "not measured": the launch file passes `value or 0.0` for
        # unmeasured yaml entries, and ROS parameters cannot carry null. It is
        # mapped to None below so the kinematics block the output.
        self.declare_parameter("track_width_m", 0.0)
        self.declare_parameter("max_linear_speed_mps", 0.1)
        self.declare_parameter("max_angular_speed_rps", 0.3)
        self.declare_parameter("left_wheel_direction", 1.0)
        self.declare_parameter("right_wheel_direction", 1.0)
        self.declare_parameter("cmd_timeout_sec", 0.35)

        self.hardware_enabled = bool(self.get_parameter("hardware_enabled").value)
        track_width = float(self.get_parameter("track_width_m").value)
        self.limits = VehicleLimits.for_differential(
            max_linear_speed_mps=float(self.get_parameter("max_linear_speed_mps").value),
            max_angular_speed_rps=float(self.get_parameter("max_angular_speed_rps").value),
            track_width_m=track_width if track_width > 0.0 else None,
            left_wheel_direction=float(self.get_parameter("left_wheel_direction").value),
            right_wheel_direction=float(self.get_parameter("right_wheel_direction").value),
        )
        if self.hardware_enabled:
            self.limits.validate_differential()
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
        self.left_pub = self.create_publisher(Float64, "/bbiyong/actuator/wheel_left", 10)
        self.right_pub = self.create_publisher(Float64, "/bbiyong/actuator/wheel_right", 10)
        self.create_subscription(Twist, "/cmd_vel", self._twist_callback, 10)
        self.create_subscription(Bool, "/bbiyong/estop", self._estop_callback, CONTROL_STATE_QOS)
        self.create_timer(0.05, self._tick)
        if not self.hardware_enabled:
            self.get_logger().warn("hardware_enabled=false: actuator outputs are forced to zero")
        if self.limits.track_width_m is None:
            self.get_logger().error(
                "track_width_m is not measured: wheel outputs stay at zero until "
                "vehicle.yaml provides the measured track width"
            )

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
        self.left_pub.publish(Float64(data=0.0))
        self.right_pub.publish(Float64(data=0.0))

    def _tick(self) -> None:
        if not self.hardware_enabled or self.estop or self.watchdog.expired(self._now()):
            self._publish_stop()
            return
        command = twist_to_differential(
            self.last_twist.linear.x,
            self.last_twist.angular.z,
            self.limits,
        )
        if command.unconfigured_track_width:
            self.get_logger().warn(
                "track_width_m is not measured: wheel outputs blocked", throttle_duration_sec=2.0
            )
        elif command.scaled_to_limit:
            self.get_logger().warn(
                "wheel speed limit reached: both wheels scaled to keep the commanded curvature",
                throttle_duration_sec=2.0,
            )
        self.left_pub.publish(Float64(data=command.left))
        self.right_pub.publish(Float64(data=command.right))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = DifferentialAdapter()
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
