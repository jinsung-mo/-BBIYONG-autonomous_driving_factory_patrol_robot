"""Validation and camera-ray helpers for the dashboard JPEG input."""

import base64
import math

import cv2
import numpy as np


def decode_dashboard_frame(payload):
    """Validate a dashboard payload and return (capture_time, BGR image)."""
    if not isinstance(payload, dict):
        raise ValueError("dashboard payload is not an object")
    if payload.get("img_ok") is False:
        raise ValueError("camera reported img_ok=false")
    capture_time = float(payload["t"])
    if not math.isfinite(capture_time) or capture_time <= 0.0:
        raise ValueError("dashboard timestamp is invalid")
    encoded = payload.get("jpeg")
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("dashboard JPEG is missing")
    try:
        compressed = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("dashboard JPEG base64 is invalid") from exc
    image = cv2.imdecode(np.frombuffer(compressed, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError("dashboard JPEG cannot be decoded")
    expected_width = int(payload.get("out_w", image.shape[1]))
    expected_height = int(payload.get("out_h", image.shape[0]))
    if expected_width <= 0 or expected_height <= 0:
        raise ValueError("dashboard dimensions are invalid")
    if image.shape[1] != expected_width or image.shape[0] != expected_height:
        raise ValueError("dashboard JPEG dimensions do not match its metadata")
    return capture_time, image


def pinhole_from_hfov(width, height, horizontal_fov_degrees):
    """Return fx, fy, cx, cy for a square-pixel pinhole approximation."""
    if width <= 0 or height <= 0 or not 1.0 < horizontal_fov_degrees < 179.0:
        raise ValueError("invalid image dimensions or horizontal field of view")
    focal = (width * 0.5) / math.tan(math.radians(horizontal_fov_degrees) * 0.5)
    return focal, focal, (width - 1) * 0.5, (height - 1) * 0.5


def timestamp_fields(timestamp):
    seconds = int(timestamp)
    nanoseconds = int(round((timestamp - seconds) * 1_000_000_000))
    if nanoseconds >= 1_000_000_000:
        seconds += 1
        nanoseconds = 0
    return {"sec": seconds, "nanosec": nanoseconds}
