#!/usr/bin/env python3
"""Publish fail-safe mux state from the dashboard's atomic control file."""

from __future__ import annotations

import json
import os
from pathlib import Path
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import Bool, String


class ControlStateBridge(Node):
    VALID_MODES = {"disabled", "manual", "autonomy"}

    def __init__(self) -> None:
        super().__init__("bbiyong_control_state_bridge")
        self.declare_parameter("control_file", "/tmp/bbiyong_control.json")
        self.declare_parameter("publish_rate_hz", 10.0)
        self.control_file = Path(
            str(self.get_parameter("control_file").value)
        ).expanduser()
        rate = float(self.get_parameter("publish_rate_hz").value)
        if rate <= 0.0:
            raise ValueError("publish_rate_hz must be positive")

        qos = QoSProfile(
            depth=1,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            reliability=ReliabilityPolicy.RELIABLE,
        )
        self.mode_publisher = self.create_publisher(
            String, "/bbiyong/control_mode", qos
        )
        self.estop_publisher = self.create_publisher(Bool, "/bbiyong/estop", qos)
        self.create_subscription(
            Bool, "/bbiyong/estop_request", self._on_estop_request, 10
        )
        self.mode = "disabled"
        self.estop = True
        self.sequence = -1
        self.started_at = time.time()
        self.create_timer(1.0 / rate, self._tick)
        self.get_logger().warning(
            "control state starts disabled with emergency stop active"
        )

    def _write_state(self) -> None:
        payload = {
            "schemaVersion": 1,
            "seq": self.sequence,
            "mode": self.mode,
            "estop": self.estop,
            "updatedAt": time.time(),
        }
        self.control_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.control_file.with_name(self.control_file.name + ".tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(temporary, self.control_file)

    def _on_estop_request(self, message: Bool) -> None:
        if not bool(message.data):
            return
        self.sequence = max(0, self.sequence + 1)
        self.mode = "disabled"
        self.estop = True
        try:
            self._write_state()
        except OSError as exc:
            self.get_logger().error(f"failed to persist emergency stop: {exc}")
        self.mode_publisher.publish(String(data=self.mode))
        self.estop_publisher.publish(Bool(data=True))
        self.get_logger().warning("emergency stop request latched")

    def _read(self):
        try:
            payload = json.loads(self.control_file.read_text(encoding="utf-8"))
            sequence = int(payload["seq"])
            mode = str(payload["mode"]).strip().lower()
            estop = payload["estop"]
            updated_at = float(payload["updatedAt"])
        except (OSError, ValueError, TypeError, KeyError):
            return None
        if (
            sequence < 0
            or mode not in self.VALID_MODES
            or not isinstance(estop, bool)
        ):
            return None
        # Never replay a release left by a previous runtime invocation.
        if updated_at < self.started_at - 1.0:
            return None
        return sequence, mode, estop

    def _tick(self) -> None:
        state = self._read()
        if state is not None:
            sequence, mode, estop = state
            if sequence >= self.sequence:
                changed = (mode, estop) != (self.mode, self.estop)
                self.sequence = sequence
                self.mode = mode
                self.estop = estop
                if changed:
                    self.get_logger().info(
                        f"control state: mode={self.mode} estop={self.estop}"
                    )
        self.mode_publisher.publish(String(data=self.mode))
        self.estop_publisher.publish(Bool(data=self.estop))

    def stop(self) -> None:
        self.mode_publisher.publish(String(data="disabled"))
        self.estop_publisher.publish(Bool(data=True))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = ControlStateBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if rclpy.ok(context=node.context):
                node.stop()
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


if __name__ == "__main__":
    main()
