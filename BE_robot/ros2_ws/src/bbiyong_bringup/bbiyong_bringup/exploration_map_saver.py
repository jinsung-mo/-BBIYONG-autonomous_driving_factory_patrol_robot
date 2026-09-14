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
        # A previous transient-local explorer publisher can remain discoverable
        # briefly and replay its final `completed=True` into a newly launched
        # saver.  Arm only after this mission's explorer announces False.
        #
        # 🔴 [2026-08-10] False 를 **놓치는 경합**이 실재한다. 발행 QoS 가
        #    TRANSIENT_LOCAL depth=1 이라 마지막 값만 남고, 구독이 붙는 타이밍이
        #    어긋나면 False 를 못 본다. 그러면 진짜 True 를 조용히 버리고
        #    explorer·saver 둘 다 살아 있는 채로 영원히 대기한다
        #    (07:54:06 "Exploration finished" 뒤 6분간 무반응 — 실측).
        #
        #    그래서 무장 조건을 **시간**으로도 연다. 두 경우는 시간으로 갈린다:
        #      · 옛 발행자의 재생 -> 기동 직후 수 초 안
        #      · 진짜 완료        -> 탐사가 실제로 돈 뒤 수 분 뒤 (최단 세션도 74초)
        #    두 구간이 겹치지 않으므로 재생 방지 효과는 유지된다.
        self._completion_armed = False
        self.declare_parameter("stale_replay_guard_sec", 30.0)
        self._started_at = time.monotonic()
        self._exit_code = None
        qos = QoSProfile(depth=1)
        qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        qos.reliability = ReliabilityPolicy.RELIABLE
        self._saved_publisher = self.create_publisher(Bool, "~/saved", qos)
        self._saved_publisher.publish(Bool(data=False))
        self.create_subscription(Bool, "/frontier_explorer/completed", self._completed, qos)

    @property
    def finished(self) -> bool:
        return self._exit_code is not None

    @property
    def exit_code(self) -> int:
        return 1 if self._exit_code is None else self._exit_code

    def _request_exit(self, exit_code: int) -> None:
        self._exit_code = exit_code

    def _armed(self) -> bool:
        """무장 여부. False 수신 **또는** 기동 후 guard 초 경과.

        시간 조건이 없으면 False 를 놓쳤을 때 진짜 완료를 영원히 버린다(2026-08-10 실측).
        """
        if self._completion_armed:
            return True
        guard = float(self.get_parameter("stale_replay_guard_sec").value)
        if time.monotonic() - self._started_at >= guard:
            self.get_logger().warning(
                "completed=False 를 못 받았지만 기동 후 %.0f초가 지나 무장한다 "
                "— 옛 발행자의 재생이 아니라 실제 완료로 본다" % guard
            )
            self._completion_armed = True
            return True
        return False

    def _completed(self, message: Bool) -> None:
        if not message.data:
            self._completion_armed = True
            return
        if self._saving or not self._armed():
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
            self._request_exit(1)
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
                self._request_exit(0)
                return
            except Exception as error:
                self.get_logger().error(f"map save attempt {attempt}/{attempts} failed: {error}")
                if attempt < attempts:
                    time.sleep(retry_delay)
        self.get_logger().error("map save failed after all retry attempts")
        self._request_exit(1)


def main(args=None) -> int:
    rclpy.init(args=args)
    node = ExplorationMapSaver()
    try:
        # Map saving runs in a worker thread. Keep lifecycle ownership in this
        # main thread and stop spinning as soon as that worker reports a result.
        while rclpy.ok() and not node.finished:
            rclpy.spin_once(node, timeout_sec=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        exit_code = node.exit_code
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return exit_code
