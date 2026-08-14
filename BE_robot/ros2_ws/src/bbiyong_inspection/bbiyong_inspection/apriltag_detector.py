#!/usr/bin/env python3
"""AprilTag detection from the camera node's existing 2 Hz dashboard JPEG.

This node never opens the camera and never alters the 30 FPS H.264 pipeline.
It defensively polls the atomic JSON preview written by camera_node.py.
"""

from __future__ import annotations

import json
from pathlib import Path
import time

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

from .dashboard_frame import decode_dashboard_frame, pinhole_from_hfov, timestamp_fields
from .protocol import encode_object


FAMILY_CONSTANTS = {
    "tag16h5": "DICT_APRILTAG_16h5",
    "tag25h9": "DICT_APRILTAG_25h9",
    "tag36h10": "DICT_APRILTAG_36h10",
    "tag36h11": "DICT_APRILTAG_36h11",
}


class AprilTagDetector(Node):
    def __init__(self):
        super().__init__("bbiyong_apriltag_detector")
        self.declare_parameter("dashboard_file", "/tmp/orincar_cam.json")
        self.declare_parameter("camera_frame", "camera_optical_frame")
        self.declare_parameter("detections_topic", "/apriltag/detections")
        self.declare_parameter("status_topic", "/apriltag/status")
        self.declare_parameter("tag_family", "tag36h11")
        self.declare_parameter("tag_size_m", 0.12)
        self.declare_parameter("poll_hz", 2.0)
        self.declare_parameter("max_frame_age_sec", 1.5)
        self.declare_parameter("camera_hfov_deg", 48.0)
        self.declare_parameter("min_stable_frames", 3)
        self.declare_parameter("stability_timeout_sec", 1.25)
        self.declare_parameter("max_center_jump_px", 24.0)

        self.dashboard_file = Path(
            str(self.get_parameter("dashboard_file").value)
        ).expanduser()
        self.camera_frame = str(self.get_parameter("camera_frame").value)
        self.tag_size = float(self.get_parameter("tag_size_m").value)
        self.poll_hz = float(self.get_parameter("poll_hz").value)
        self.max_frame_age = float(self.get_parameter("max_frame_age_sec").value)
        self.camera_hfov = float(self.get_parameter("camera_hfov_deg").value)
        self.min_stable_frames = int(self.get_parameter("min_stable_frames").value)
        self.stability_timeout = float(
            self.get_parameter("stability_timeout_sec").value
        )
        self.max_center_jump = float(self.get_parameter("max_center_jump_px").value)
        if self.tag_size <= 0.0 or self.poll_hz <= 0.0 or self.max_frame_age <= 0.0:
            raise ValueError("tag size, poll rate, and maximum frame age must be positive")
        if not 1.0 < self.camera_hfov < 179.0:
            raise ValueError("camera_hfov_deg must be between 1 and 179 degrees")
        if self.min_stable_frames < 1:
            raise ValueError("min_stable_frames must be at least one")

        self.last_capture_time = None
        self.last_valid_frame_at = None
        self.input_error = f"waiting for {self.dashboard_file}"
        self.tracks = {}
        self.detector = None
        self.detector_error = ""
        self._configure_detector(str(self.get_parameter("tag_family").value))

        self.detection_publisher = self.create_publisher(
            String, str(self.get_parameter("detections_topic").value), 10
        )
        self.status_publisher = self.create_publisher(
            String, str(self.get_parameter("status_topic").value), 10
        )
        self.create_timer(1.0 / self.poll_hz, self._poll_dashboard)
        self.create_timer(2.0, self._publish_status)
        self._publish_status()

    def _configure_detector(self, family):
        try:
            aruco = cv2.aruco
            constant_name = FAMILY_CONSTANTS.get(family.lower())
            if constant_name is None or not hasattr(aruco, constant_name):
                raise ValueError(f"unsupported AprilTag family: {family}")
            dictionary = aruco.getPredefinedDictionary(getattr(aruco, constant_name))
            parameters = (
                aruco.DetectorParameters()
                if hasattr(aruco, "DetectorParameters")
                else aruco.DetectorParameters_create()
            )
            if hasattr(aruco, "ArucoDetector"):
                self.detector = aruco.ArucoDetector(dictionary, parameters).detectMarkers
            else:
                self.detector = lambda image: aruco.detectMarkers(
                    image, dictionary, parameters=parameters
                )
        except (AttributeError, ValueError) as exc:
            self.detector_error = str(exc)
            self.get_logger().error(
                f"AprilTag backend unavailable; node will remain idle: {exc}"
            )

    def _publish_status(self):
        if self.detector is None:
            state, reason = "DEGRADED", self.detector_error
        elif self.last_valid_frame_at is None:
            state, reason = "DEGRADED", self.input_error
        elif time.monotonic() - self.last_valid_frame_at > self.max_frame_age + 0.5:
            state, reason = "DEGRADED", self.input_error or "dashboard frames stopped"
        else:
            state, reason = "READY", ""
        self.status_publisher.publish(String(data=encode_object(
            "apriltag_status",
            state=state,
            reason=reason,
            input="dashboard_jpeg",
            inputFile=str(self.dashboard_file),
            pollHz=self.poll_hz,
        )))

    def _stable(self, tag_id, center, now):
        previous = self.tracks.get(tag_id)
        if previous is None or now - previous["time"] > self.stability_timeout:
            count = 1
        elif np.linalg.norm(center - previous["center"]) <= self.max_center_jump:
            count = previous["count"] + 1
        else:
            count = 1
        self.tracks[tag_id] = {"center": center, "count": count, "time": now}
        return count >= self.min_stable_frames, count

    def _poll_dashboard(self):
        if self.detector is None:
            return
        try:
            payload = json.loads(self.dashboard_file.read_text(encoding="utf-8"))
            capture_time, image = decode_dashboard_frame(payload)
            age = time.time() - capture_time
            if age < -1.0 or age > self.max_frame_age:
                raise ValueError(f"dashboard frame is stale ({age:.2f}s old)")
            if self.last_capture_time is not None and capture_time <= self.last_capture_time:
                return
            if not self._detect(image, capture_time):
                return
            self.last_capture_time = capture_time
            self.last_valid_frame_at = time.monotonic()
            self.input_error = ""
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self.input_error = str(exc)

    def _detect(self, image, capture_time):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        try:
            corners, ids, _rejected = self.detector(gray)
        except Exception as exc:  # OpenCV failures must not stop ROS or the camera.
            self.input_error = f"AprilTag detection failed: {exc}"
            self.get_logger().error(self.input_error)
            return False

        now = time.monotonic()
        height, width = gray.shape
        fx, fy, cx, cy = pinhole_from_hfov(width, height, self.camera_hfov)
        detections = []
        seen = set()
        if ids is not None:
            for tag_id_raw, corner_raw in zip(ids.flatten(), corners):
                tag_id = int(tag_id_raw)
                points = np.asarray(corner_raw, dtype=float).reshape(4, 2)
                center = points.mean(axis=0)
                stable, stable_frames = self._stable(tag_id, center, now)
                seen.add(tag_id)
                if not stable:
                    continue
                ray = np.array([
                    (center[0] - cx) / fx,
                    (center[1] - cy) / fy,
                    1.0,
                ], dtype=float)
                ray /= np.linalg.norm(ray)
                detections.append({
                    "tagId": tag_id,
                    "center": {"u": float(center[0]), "v": float(center[1])},
                    "corners": points.tolist(),
                    "ray": ray.tolist(),
                    "rayCalibration": "estimated_hfov",
                    "stableFrames": stable_frames,
                    "confidence": min(1.0, stable_frames / self.min_stable_frames),
                    "tagSizeM": self.tag_size,
                })
        cutoff = now - self.stability_timeout
        self.tracks = {
            tag_id: track
            for tag_id, track in self.tracks.items()
            if track["time"] >= cutoff or tag_id in seen
        }
        self.detection_publisher.publish(String(data=encode_object(
            "apriltag_detections",
            frameId=self.camera_frame,
            stamp=timestamp_fields(capture_time),
            imageWidth=width,
            imageHeight=height,
            source="dashboard_jpeg",
            detections=detections,
        )))
        return True


def main(args=None):
    rclpy.init(args=args)
    node = AprilTagDetector()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    main()
