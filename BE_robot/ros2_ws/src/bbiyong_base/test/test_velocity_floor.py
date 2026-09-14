import unittest

from bbiyong_base.velocity_floor import enforce_in_place_rotation_floor


class VelocityFloorTest(unittest.TestCase):
    def apply(self, linear_x: float, angular_z: float) -> tuple[float, float]:
        return enforce_in_place_rotation_floor(
            linear_x,
            angular_z,
            minimum_angular_speed=0.42,
            minimum_input_angular_speed=0.05,
            linear_epsilon=0.01,
        )

    def test_raises_deliberate_in_place_turn(self) -> None:
        self.assertEqual(self.apply(0.0, 0.20), (0.0, 0.42))
        self.assertEqual(self.apply(0.0, -0.20), (0.0, -0.42))

    def test_preserves_zero_and_controller_noise(self) -> None:
        self.assertEqual(self.apply(0.0, 0.0), (0.0, 0.0))
        self.assertEqual(self.apply(0.0, 0.02), (0.0, 0.02))

    def test_preserves_curved_driving_and_stronger_rotation(self) -> None:
        self.assertEqual(self.apply(0.05, 0.20), (0.05, 0.20))
        self.assertEqual(self.apply(0.0, 0.50), (0.0, 0.50))


if __name__ == "__main__":
    unittest.main()
