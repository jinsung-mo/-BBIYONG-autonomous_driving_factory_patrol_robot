"""Fail-safe WSS-to-ROS manual-control bridge."""

import json
from math import cos, sin
from pathlib import Path
from queue import Empty, Queue
import subprocess
from threading import Event, Lock, Thread

import rclpy
from geometry_msgs.msg import PoseStamped, Twist
from rclpy.node import Node
from std_msgs.msg import Bool, String

from .remote_control_protocol import RemoteActions, failsafe_actions, parse_remote_command


class RemoteControlBridge(Node):
    def __init__(self) -> None:
        super().__init__("bbiyong_remote_control_bridge")
        self.declare_parameter("wss_url", "")
        self.declare_parameter("robot_id", "orinka_01")
        self.declare_parameter("max_linear_mps", 0.15)
        self.declare_parameter("max_angular_rps", 0.5)
        self.declare_parameter("reconnect_sec", 3.0)
        self.declare_parameter("connect_timeout_sec", 5.0)
        self.declare_parameter("authorization_header", "")
        self.declare_parameter("map_output_dir", "~/maps")
        self.wss_url = str(self.get_parameter("wss_url").value)
        self.robot_id = str(self.get_parameter("robot_id").value)
        self.max_linear = float(self.get_parameter("max_linear_mps").value)
        self.max_angular = float(self.get_parameter("max_angular_rps").value)
        self.reconnect_sec = float(self.get_parameter("reconnect_sec").value)
        self.connect_timeout_sec = float(self.get_parameter("connect_timeout_sec").value)
        self.authorization_header = str(self.get_parameter("authorization_header").value)
        self.map_output_dir = Path(str(self.get_parameter("map_output_dir").value)).expanduser().resolve()
        if not self.wss_url.startswith(("ws://", "wss://")):
            raise ValueError("wss_url must start with ws:// or wss://")
        if not self.robot_id.strip() or min(self.max_linear, self.max_angular, self.reconnect_sec, self.connect_timeout_sec) <= 0.0:
            raise ValueError("robot_id and remote-control limits must be positive")

        self.manual_pub = self.create_publisher(Twist, "/cmd_vel/manual", 10)
        self.mode_pub = self.create_publisher(String, "/bbiyong/control_mode", 10)
        self.estop_pub = self.create_publisher(Bool, "/bbiyong/estop", 10)
        self.goal_pub = self.create_publisher(PoseStamped, "/goal_pose", 10)
        self.actions: Queue[RemoteActions] = Queue()
        self.stop_event = Event()
        self._socket_lock = Lock()
        self._socket = None
        self.create_timer(0.02, self._drain_actions)
        self._queue_failsafe()
        self.thread = Thread(target=self._connect_loop, name="bbiyong-wss", daemon=True)
        self.thread.start()

    def _queue_failsafe(self) -> None:
        self.actions.put(failsafe_actions())

    def _drain_actions(self) -> None:
        while True:
            try:
                self._publish_actions(self.actions.get_nowait())
            except Empty:
                return

    def _publish_actions(self, actions: RemoteActions) -> None:
        if actions.linear is not None:
            message = Twist()
            message.linear.x = actions.linear
            message.angular.z = actions.angular or 0.0
            self.manual_pub.publish(message)
        if actions.mode is not None:
            self.mode_pub.publish(String(data=actions.mode))
        if actions.estop is not None:
            self.estop_pub.publish(Bool(data=actions.estop))
        if actions.goal is not None:
            x, y, yaw = actions.goal
            goal = PoseStamped()
            goal.header.frame_id = "map"
            goal.header.stamp = self.get_clock().now().to_msg()
            goal.pose.position.x = x
            goal.pose.position.y = y
            goal.pose.orientation.z = sin(yaw / 2.0)
            goal.pose.orientation.w = cos(yaw / 2.0)
            self.goal_pub.publish(goal)
        if actions.map_name is not None:
            self.map_output_dir.mkdir(parents=True, exist_ok=True)
            output = self.map_output_dir / actions.map_name
            subprocess.Popen(
                ["ros2", "run", "nav2_map_server", "map_saver_cli", "-f", str(output)],
                start_new_session=True,
            )

    def _connect_loop(self) -> None:
        try:
            import websocket
        except ImportError:
            self.get_logger().error("websocket-client is not installed; remote control remains fail-safe")
            self._queue_failsafe()
            return
        while not self.stop_event.is_set():
            socket = None
            try:
                headers = [f"Authorization: {self.authorization_header}"] if self.authorization_header else None
                socket = websocket.create_connection(
                    self.wss_url, timeout=self.connect_timeout_sec, header=headers
                )
                with self._socket_lock:
                    self._socket = socket
                socket.send(json.dumps({"type": "REGISTER", "robot_id": self.robot_id}))
                self.get_logger().info("remote-control WSS connected; ESTOP remains active until local release")
                while not self.stop_event.is_set():
                    try:
                        message = socket.recv()
                    except websocket.WebSocketTimeoutException:
                        continue
                    if not message:
                        raise ConnectionError("WSS closed")
                    if isinstance(message, bytes):
                        message = message.decode("utf-8")
                    try:
                        self.actions.put(parse_remote_command(message, self.max_linear, self.max_angular))
                    except ValueError as error:
                        self.get_logger().warn(f"ignored remote command: {error}")
            except Exception as error:
                if not self.stop_event.is_set():
                    self.get_logger().warn(f"remote-control WSS unavailable: {error}")
                    self._queue_failsafe()
                    self.stop_event.wait(self.reconnect_sec)
            finally:
                with self._socket_lock:
                    if self._socket is socket:
                        self._socket = None
                if socket is not None:
                    try:
                        socket.close()
                    except Exception:
                        pass

    def destroy_node(self):
        self.stop_event.set()
        with self._socket_lock:
            socket = self._socket
        if socket is not None:
            try:
                socket.close()
            except Exception:
                pass
        if self.thread.is_alive():
            self.thread.join(timeout=min(1.0, self.connect_timeout_sec))
        try:
            if rclpy.ok(context=self.context):
                self._publish_actions(failsafe_actions())
        except Exception:
            # SIGINT can invalidate the ROS context before node destruction.
            pass
        return super().destroy_node()


def main(args=None) -> None:
    rclpy.init(args=args)
    node = RemoteControlBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
