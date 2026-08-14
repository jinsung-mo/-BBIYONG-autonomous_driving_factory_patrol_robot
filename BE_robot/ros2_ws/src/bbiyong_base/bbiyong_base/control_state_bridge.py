#!/usr/bin/env python3
"""Publish fail-safe mux state from one persistent authority."""

from __future__ import annotations

import json
import os
from pathlib import Path
import time

import rclpy
from rclpy.node import Node
from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, String
from std_srvs.srv import SetBool, Trigger


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

        self.mode_publisher = self.create_publisher(
            String, "/bbiyong/control_mode", CONTROL_STATE_QOS
        )
        self.estop_publisher = self.create_publisher(Bool, "/bbiyong/estop", CONTROL_STATE_QOS)
        self.create_subscription(
            Bool, "/bbiyong/estop_request", self._on_estop_request, 10
        )
        self.create_service(
            SetBool, "/bbiyong/set_autonomy", self._on_set_autonomy
        )
        self.create_service(
            Trigger, "/bbiyong/set_manual", self._on_set_manual
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

    def _publish_state(self) -> None:
        self.mode_publisher.publish(String(data=self.mode))
        self.estop_publisher.publish(Bool(data=self.estop))

    def _transition(self, mode: str, estop: bool, reason: str) -> tuple[bool, str]:
        """Atomically persist and publish one authoritative control transition."""
        previous = (self.sequence, self.mode, self.estop)
        self.sequence = max(0, self.sequence + 1)
        self.mode = mode
        self.estop = estop
        try:
            self._write_state()
        except OSError as exc:
            if not estop:
                # Never release motion unless the latched state was persisted.
                self.sequence, self.mode, self.estop = previous
                self.mode = "disabled"
                self.estop = True
                self._publish_state()
                message = f"arm refused; failed to persist control state: {exc}"
                self.get_logger().error(message)
                return False, message
            self.get_logger().error(f"failed to persist emergency stop: {exc}")

        self._publish_state()
        message = f"control state: mode={self.mode} estop={self.estop} ({reason})"
        self.get_logger().info(message)
        return True, message

    def _on_set_autonomy(self, request, response):
        if bool(request.data):
            success, message = self._transition(
                "autonomy", False, "confirmed autonomy request"
            )
        else:
            success, message = self._transition(
                "disabled", True, "confirmed stop request"
            )
        response.success = success
        response.message = message
        return response

    def _on_set_manual(self, request, response):
        del request
        success, message = self._transition(
            "manual", False, "confirmed manual request"
        )
        response.success = success
        response.message = message
        return response

    def _on_estop_request(self, message: Bool) -> None:
        if not bool(message.data):
            return
        success, _ = self._transition(
            "disabled", True, "emergency stop request"
        )
        if success:
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
        self._publish_state()

    def stop(self) -> None:
        self.mode = "disabled"
        self.estop = True
        self._publish_state()


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
