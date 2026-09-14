import base64
import unittest

import cv2
import numpy as np

from bbiyong_inspection.dashboard_frame import (
    decode_dashboard_frame,
    pinhole_from_hfov,
    timestamp_fields,
)


class DashboardFrameTests(unittest.TestCase):
    def payload(self):
        image = np.zeros((30, 40, 3), dtype=np.uint8)
        ok, encoded = cv2.imencode(".jpg", image)
        self.assertTrue(ok)
        return {
            "t": 123.25,
            "out_w": 40,
            "out_h": 30,
            "jpeg": base64.b64encode(encoded).decode("ascii"),
            "img_ok": True,
        }

    def test_decodes_valid_atomic_dashboard_payload(self):
        capture_time, image = decode_dashboard_frame(self.payload())
        self.assertEqual(capture_time, 123.25)
        self.assertEqual(image.shape, (30, 40, 3))

    def test_rejects_metadata_dimension_mismatch(self):
        payload = self.payload()
        payload["out_w"] = 41
        with self.assertRaisesRegex(ValueError, "dimensions"):
            decode_dashboard_frame(payload)

    def test_rejects_invalid_base64(self):
        payload = self.payload()
        payload["jpeg"] = "not base64!"
        with self.assertRaisesRegex(ValueError, "base64"):
            decode_dashboard_frame(payload)

    def test_hfov_pinhole_centers_preview(self):
        fx, fy, cx, cy = pinhole_from_hfov(400, 300, 90.0)
        self.assertAlmostEqual(fx, 200.0)
        self.assertAlmostEqual(fy, 200.0)
        self.assertEqual((cx, cy), (199.5, 149.5))

    def test_timestamp_normalizes_nanosecond_rounding(self):
        self.assertEqual(timestamp_fields(12.25), {"sec": 12, "nanosec": 250000000})
