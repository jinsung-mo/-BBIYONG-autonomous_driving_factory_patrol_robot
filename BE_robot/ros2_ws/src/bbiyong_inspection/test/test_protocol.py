import math
import unittest

from bbiyong_inspection.protocol import (
    decode_object,
    encode_object,
    validate_candidate,
    validate_point,
)


def candidate():
    return {
        "candidateId": "tag-active-map-7",
        "source": "APRILTAG",
        "mapId": "active-map",
        "tagId": 7,
        "target": {"x": 2.0, "y": 3.0},
        "viewpoint": {"x": 1.2, "y": 3.0, "yaw": 0.0},
        "standOffM": 0.8,
        "confidence": 0.9,
        "createdAt": 10.0,
    }


class ProtocolTests(unittest.TestCase):
    def test_versioned_json_round_trip(self):
        text = encode_object("example", value=3)
        self.assertEqual(decode_object(text, kind="example")["value"], 3)

    def test_candidate_rejects_nan(self):
        value = candidate()
        value["target"]["x"] = math.nan
        with self.assertRaisesRegex(ValueError, "finite"):
            validate_candidate(value)

    def test_candidate_rejects_unknown_source(self):
        value = candidate()
        value["source"] = "NETWORK"
        with self.assertRaisesRegex(ValueError, "source"):
            validate_candidate(value)

    def test_point_validation_preserves_wall_and_viewpoint(self):
        value = {
            **candidate(),
            "id": "point-7",
            "name": "Panel 7",
            "enabled": True,
            "sequence": 2,
            "updatedAt": 11.0,
        }
        point = validate_point(value)
        self.assertEqual(point["target"], {"x": 2.0, "y": 3.0})
        self.assertEqual(point["viewpoint"]["x"], 1.2)
        self.assertEqual(point["sequence"], 2)


if __name__ == "__main__":
    unittest.main()
