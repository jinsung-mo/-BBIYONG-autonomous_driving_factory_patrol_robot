import json
import math
from pathlib import Path
import tempfile
import unittest

from bbiyong_bringup.patrol_route_model import (
    load_route,
    resume_order,
    validate_route,
    yaw_quaternion,
)


class PatrolRouteModelTest(unittest.TestCase):
    def test_exact_backend_payload_is_sorted_and_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "route.json"
            path.write_text(json.dumps({
                "robotId": "orinka_01",
                "waypoints": [
                    {"seq": 2, "x": 2, "y": 3, "yaw": None, "name": "b"},
                    {"seq": 0, "x": 0.5, "y": -1, "yaw": math.pi},
                ],
            }))
            route = load_route(path)
        self.assertEqual([point["seq"] for point in route], [0, 2])
        self.assertEqual(route[1]["yaw"], 0.0)

    def test_rejects_empty_duplicate_non_finite_and_excessive_routes(self):
        invalid = [
            [],
            [{"seq": 0, "x": 0, "y": 0}, {"seq": 0, "x": 1, "y": 1}],
            [{"seq": 0, "x": float("inf"), "y": 0}],
            [{"seq": index, "x": 0, "y": 0} for index in range(501)],
        ]
        for route in invalid:
            with self.subTest(size=len(route)):
                with self.assertRaises(ValueError):
                    validate_route(route)

    def test_yaw_quaternion_and_resume_order(self):
        z, w = yaw_quaternion(math.pi)
        self.assertAlmostEqual(z, 1.0)
        self.assertAlmostEqual(w, 0.0)
        self.assertEqual(resume_order(4, 2, False), [2, 3])
        self.assertEqual(resume_order(4, 2, True), [2, 3, 0, 1])


if __name__ == "__main__":
    unittest.main()
