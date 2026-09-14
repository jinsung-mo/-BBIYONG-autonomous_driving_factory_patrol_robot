from dataclasses import dataclass

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, String


@dataclass
class TimedTwist:
    message: Twist | None = None
    received_sec: float = float("-inf")


class CommandMux(Node):
    """Single publisher for /cmd_vel with explicit mode and emergency stop."""

    def __init__(self) -> None:
        super().__init__("bbiyong_cmd_mux")
        self.declare_parameter("manual_timeout_sec", 0.5)
        self.declare_parameter("autonomy_timeout_sec", 0.5)
        self.declare_parameter("escape_timeout_sec", 0.5)
        self.declare_parameter("publish_rate_hz", 20.0)
        self.manual_timeout = float(self.get_parameter("manual_timeout_sec").value)
        self.autonomy_timeout = float(self.get_parameter("autonomy_timeout_sec").value)
        self.escape_timeout = float(self.get_parameter("escape_timeout_sec").value)
        rate = float(self.get_parameter("publish_rate_hz").value)
        if min(self.manual_timeout, self.autonomy_timeout, rate) <= 0.0:
            raise ValueError("mux timeouts and publish_rate_hz must be positive")

        self.mode = "disabled"
        self.estop = True
        self.manual = TimedTwist()
        self.autonomy = TimedTwist()
        # 끼임 탈출 후진. autonomy 보다 위지만 estop/mode 는 그대로 따른다.
        self.escape = TimedTwist()
        # (S15P11E101-801) 발행자(control_state_bridge.py)는 TRANSIENT_LOCAL 로 마지막
        # 상태를 래치해 보낸다 — 늦게 붙는 구독자도 DDS discovery 를 기다리지 않고
        # 즉시 현재 arm/estop 상태를 받아야 한다. 순정수(10)면 기본 QoS인 VOLATILE 이
        # 되어 래치된 값을 못 받고 재시작 시 몇 초~몇십 초간 disabled/estop=True 에
        # 갇힌다(exploration_node.py 에서 실기 확인된 것과 같은 버그).
        self.publisher = self.create_publisher(Twist, "/cmd_vel", 10)
        self.create_subscription(Twist, "/cmd_vel/manual", self._manual_callback, 10)
        self.create_subscription(Twist, "/cmd_vel/autonomy", self._autonomy_callback, 10)
        self.create_subscription(Twist, "/cmd_vel/escape", self._escape_callback, 10)
        self.create_subscription(String, "/bbiyong/control_mode", self._mode_callback, CONTROL_STATE_QOS)
        self.create_subscription(Bool, "/bbiyong/estop", self._estop_callback, CONTROL_STATE_QOS)
        self.create_timer(1.0 / rate, self._publish)
        self.get_logger().warn("control starts disabled with emergency stop active")

    def _now(self) -> float:
        return self.get_clock().now().nanoseconds / 1e9

    def _manual_callback(self, message: Twist) -> None:
        self.manual = TimedTwist(message, self._now())

    def _autonomy_callback(self, message: Twist) -> None:
        self.autonomy = TimedTwist(message, self._now())

    def _escape_callback(self, message: Twist) -> None:
        self.escape = TimedTwist(message, self._now())

    def _mode_callback(self, message: String) -> None:
        requested = message.data.strip().lower()
        if requested not in {"disabled", "manual", "autonomy"}:
            self.get_logger().error(f"ignored invalid control mode: {requested}")
            return
        if requested != self.mode:
            self.publisher.publish(Twist())
            # Never replay a command received under the previous owner.
            self.manual = TimedTwist()
            self.autonomy = TimedTwist()
            self.escape = TimedTwist()
            self.mode = requested
            self.get_logger().info(f"control mode: {self.mode}")

    def _estop_callback(self, message: Bool) -> None:
        requested = bool(message.data)
        if requested and not self.estop:
            self.manual = TimedTwist()
            self.autonomy = TimedTwist()
            self.escape = TimedTwist()
        self.estop = requested
        if self.estop:
            self.publisher.publish(Twist())
            self.get_logger().warn("emergency stop active")

    def _publish(self) -> None:
        now = self._now()
        selected = None
        timeout = 0.0
        if not self.estop and self.mode == "manual":
            selected, timeout = self.manual, self.manual_timeout
        elif not self.estop and self.mode == "autonomy":
            # 탈출 후진이 살아 있으면 그것을 먼저 쓴다. 두 발행자가 같은
            # 토픽을 다투는 대신, 조정은 mux 가 한다.
            if (self.escape.message is not None
                    and now - self.escape.received_sec <= self.escape_timeout):
                selected, timeout = self.escape, self.escape_timeout
            else:
                selected, timeout = self.autonomy, self.autonomy_timeout
        if selected is None or selected.message is None or now - selected.received_sec > timeout:
            self.publisher.publish(Twist())
        else:
            self.publisher.publish(selected.message)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = CommandMux()
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
