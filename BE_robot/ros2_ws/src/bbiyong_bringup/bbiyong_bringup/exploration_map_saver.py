from pathlib import Path
import subprocess
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import Bool


class ExplorationMapSaver(Node):
    def __init__(self) -> None:
        super().__init__("exploration_map_saver")
        self.declare_parameter("map_output", "~/maps/exploration_map")
        self.declare_parameter("save_map_timeout", 10.0)
        self.declare_parameter("max_attempts", 3)
        self.declare_parameter("retry_delay_sec", 2.0)
        self.declare_parameter("overwrite_existing", False)
        self._saving = False
        qos = QoSProfile(depth=1)
        qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        qos.reliability = ReliabilityPolicy.RELIABLE
        self._saved_publisher = self.create_publisher(Bool, "~/saved", qos)
        self._saved_publisher.publish(Bool(data=False))
        self.create_subscription(Bool, "/frontier_explorer/completed", self._completed, qos)

    def _completed(self, message: Bool) -> None:
        if not message.data or self._saving:
            return
        self._saving = True
        threading.Thread(target=self._save, daemon=True).start()

    def _save(self) -> None:
        base = Path(str(self.get_parameter("map_output").value)).expanduser().resolve()
        timeout = float(self.get_parameter("save_map_timeout").value)
        base.parent.mkdir(parents=True, exist_ok=True)
        files = (Path(f"{base}.pgm"), Path(f"{base}.yaml"))
        overwrite = bool(self.get_parameter("overwrite_existing").value)
        if not overwrite and any(path.exists() for path in files):
            self.get_logger().error(f"map output already exists; choose another map_output: {base}")
            self._saving = False
            return
        command = [
            "ros2", "run", "nav2_map_server", "map_saver_cli", "-f", str(base),
            "--ros-args", "-p", f"save_map_timeout:={timeout}",
        ]
        attempts = int(self.get_parameter("max_attempts").value)
        retry_delay = float(self.get_parameter("retry_delay_sec").value)
        for attempt in range(1, attempts + 1):
            try:
                subprocess.run(command, check=True)
                if any(not path.is_file() or path.stat().st_size == 0 for path in files):
                    raise RuntimeError("map files are missing or empty")
                self._saved_publisher.publish(Bool(data=True))
                self.get_logger().info(f"exploration map saved: {base}")
                return
            except Exception as error:
                self.get_logger().error(f"map save attempt {attempt}/{attempts} failed: {error}")
                if attempt < attempts:
                    time.sleep(retry_delay)
        self._saving = False


def main(args=None) -> None:
    rclpy.init(args=args)
    node = ExplorationMapSaver()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()
