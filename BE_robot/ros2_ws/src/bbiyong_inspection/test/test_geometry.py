import math
import unittest

from bbiyong_inspection.geometry import GridMap, quaternion_rotate


def make_grid(width=20, height=20, resolution=0.1):
    return GridMap(width, height, resolution, 0.0, 0.0, 0.0, [0] * (width * height))


class GeometryTests(unittest.TestCase):
    def test_world_cell_conversion_supports_rotated_map_origin(self):
        grid = GridMap(10, 10, 0.5, 2.0, -1.0, math.pi / 2.0, [0] * 100)
        x, y = grid.cell_to_world(2, 3)
        self.assertEqual(grid.world_to_cell(x, y), (2, 3))

    def test_raycast_returns_first_occupied_cell(self):
        data = [0] * 400
        data[10 * 20 + 12] = 100
        grid = GridMap(20, 20, 0.1, 0.0, 0.0, 0.0, data)
        hit, reason = grid.raycast((0.2, 1.05, 0.0), (1.0, 0.0), 2.0)
        self.assertEqual(reason, "")
        self.assertEqual(hit["cell"], (12, 10))

    def test_raycast_rejects_unknown_before_wall(self):
        data = [0] * 400
        data[10 * 20 + 8] = -1
        data[10 * 20 + 12] = 100
        grid = GridMap(20, 20, 0.1, 0.0, 0.0, 0.0, data)
        hit, reason = grid.raycast((0.2, 1.05, 0.0), (1.0, 0.0), 2.0)
        self.assertIsNone(hit)
        self.assertIn("unknown", reason)

    def test_viewpoint_faces_target_and_has_clearance(self):
        grid = make_grid()
        viewpoint = grid.viewpoint_for_target(
            (1.5, 1.0), (1.0, 0.0), stand_off_m=0.8, clearance_m=0.2
        )
        self.assertIsNotNone(viewpoint)
        self.assertAlmostEqual(viewpoint["x"], 0.7)
        self.assertAlmostEqual(viewpoint["y"], 1.0)
        self.assertAlmostEqual(viewpoint["yaw"], 0.0)

    def test_quaternion_rotation(self):
        half = math.sin(math.pi / 4.0)
        rotated = quaternion_rotate((1.0, 0.0, 0.0), (0.0, 0.0, half, half))
        self.assertAlmostEqual(rotated[0], 0.0)
        self.assertAlmostEqual(rotated[1], 1.0)


if __name__ == "__main__":
    unittest.main()
