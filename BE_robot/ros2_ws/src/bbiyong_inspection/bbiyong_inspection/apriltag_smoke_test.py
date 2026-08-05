#!/usr/bin/env python3
"""Run only the AprilTag detector and report the first stable detection."""

import argparse
from datetime import datetime, timezone
import json
import time

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from std_msgs.msg import String

from .apriltag_detector import AprilTagDetector


class DetectionProbe(Node):
    def __init__(self):
        super().__init__("bbiyong_apriltag_test_listener")
        self.detected = None
        self.detected_stamp = None
        self.status_reason = "waiting for detector status"
        self.create_subscription(
            String, "/apriltag/detections", self._on_detections, 10
        )
        self.create_subscription(String, "/apriltag/status", self._on_status, 10)

    def _on_detections(self, message):
        try:
            payload = json.loads(message.data)
            detections = payload.get("detections", [])
            if isinstance(detections, list) and detections:
                self.detected = detections[0]
                self.detected_stamp = payload.get("stamp")
        except (AttributeError, TypeError, json.JSONDecodeError):
            return

    def _on_status(self, message):
        try:
            payload = json.loads(message.data)
            state = str(payload.get("state", "UNKNOWN"))
            reason = str(payload.get("reason", "")).strip()
            self.status_reason = f"{state}: {reason}" if reason else state
        except (AttributeError, TypeError, json.JSONDecodeError):
            self.status_reason = "invalid detector status"


def detection_log_fields(detection, stamp):
    """Format capture time and an axis-aligned pixel bounding box."""
    if not isinstance(stamp, dict):
        raise ValueError("detection timestamp is missing")
    capture_epoch = float(stamp["sec"]) + float(stamp["nanosec"]) / 1_000_000_000
    capture_time = datetime.fromtimestamp(
        capture_epoch, tz=timezone.utc
    ).astimezone().isoformat(timespec="milliseconds")

    corners = detection.get("corners")
    if not isinstance(corners, list) or len(corners) != 4:
        raise ValueError("detection corners are missing")
    xs = [float(point[0]) for point in corners]
    ys = [float(point[1]) for point in corners]
    left, top = min(xs), min(ys)
    width, height = max(xs) - left, max(ys) - top
    latency_ms = max(0.0, (time.time() - capture_epoch) * 1000.0)
    return capture_time, left, top, width, height, latency_ms


def main(args=None):
    parser = argparse.ArgumentParser(
        description="Start only the AprilTag detector and wait for a stable tag."
    )
    parser.add_argument("--timeout", type=float, default=30.0)
    parsed, ros_args = parser.parse_known_args(args=args)
    if parsed.timeout <= 0.0:
        parser.error("--timeout must be positive")

    rclpy.init(args=ros_args)
    detector = AprilTagDetector()
    probe = DetectionProbe()
    executor = SingleThreadedExecutor()
    executor.add_node(detector)
    executor.add_node(probe)
    deadline = time.monotonic() + parsed.timeout
    try:
        while rclpy.ok() and probe.detected is None and time.monotonic() < deadline:
            executor.spin_once(timeout_sec=0.1)
        if probe.detected is not None:
            tag_id = probe.detected.get("tagId", "unknown")
            stable_frames = probe.detected.get("stableFrames", "unknown")
            try:
                capture_time, left, top, width, height, latency_ms = (
                    detection_log_fields(probe.detected, probe.detected_stamp)
                )
                print(
                    f"DETECTED time={capture_time} tag={tag_id} "
                    f"bbox_px=x:{left:.1f},y:{top:.1f},w:{width:.1f},h:{height:.1f} "
                    f"area_px2={width * height:.1f} latency_ms={latency_ms:.1f} "
                    f"stable_frames={stable_frames}",
                    flush=True,
                )
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                print(
                    f"DETECTED tag={tag_id} bbox_px=unavailable "
                    f"log_error={str(exc)!r} stable_frames={stable_frames}",
                    flush=True,
                )
            return 0
        print(f"NOT_DETECTED reason={probe.status_reason}", flush=True)
        return 1
    finally:
        executor.remove_node(probe)
        executor.remove_node(detector)
        probe.destroy_node()
        detector.destroy_node()
        executor.shutdown()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
