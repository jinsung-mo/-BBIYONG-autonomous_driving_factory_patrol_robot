from math import isclose, radians
import unittest

from bbiyong_base.kinematics import VehicleLimits, twist_to_ackermann, twist_to_differential
from bbiyong_base.safety import CommandWatchdog


def limits() -> VehicleLimits:
    return VehicleLimits(0.3, radians(30.0), 1.0, 1.0)


def differential_limits(track_width_m: float | None = 0.4) -> VehicleLimits:
    return VehicleLimits.for_differential(1.0, 1.0, track_width_m)


class KinematicsTest(unittest.TestCase):
    def test_straight_command(self) -> None:
        command = twist_to_ackermann(0.5, 0.0, limits())
        self.assertTrue(isclose(command.throttle, 0.5))
        self.assertTrue(isclose(command.steering_angle_rad, 0.0))

    def test_steering_is_saturated(self) -> None:
        command = twist_to_ackermann(0.1, 1.0, limits())
        self.assertTrue(isclose(command.steering_angle_rad, radians(30.0)))

    def test_in_place_rotation_is_rejected(self) -> None:
        command = twist_to_ackermann(0.0, 0.5, limits())
        self.assertEqual(command.throttle, 0.0)
        self.assertEqual(command.steering_angle_rad, 0.0)
        self.assertTrue(command.rejected_in_place_rotation)

    def test_invalid_vehicle_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            twist_to_ackermann(0.1, 0.0, VehicleLimits(0.0, 0.5, 1.0, 1.0))

    def test_differential_straight_command_is_symmetric(self) -> None:
        command = twist_to_differential(0.5, 0.0, differential_limits())
        self.assertTrue(isclose(command.left, 0.5))
        self.assertTrue(isclose(command.right, 0.5))
        self.assertFalse(command.scaled_to_limit)

    def test_differential_in_place_rotation_is_opposite(self) -> None:
        command = twist_to_differential(0.0, 0.5, differential_limits())
        self.assertTrue(isclose(command.left, -command.right))
        self.assertTrue(isclose(command.right, 0.1))
        self.assertFalse(command.unconfigured_track_width)

    def test_differential_saturation_preserves_curvature(self) -> None:
        # track 0.4 -> left 0.7 m/s, right 1.1 m/s, so the right wheel exceeds
        # the 1.0 m/s limit and both wheels must shrink by the same factor.
        command = twist_to_differential(0.9, 1.0, differential_limits())
        self.assertTrue(command.scaled_to_limit)
        self.assertTrue(isclose(command.right_mps, 1.0))
        self.assertTrue(isclose(command.left_mps, 0.7 / 1.1))
        realized_linear = (command.left_mps + command.right_mps) / 2.0
        realized_angular = (command.right_mps - command.left_mps) / 0.4
        self.assertTrue(isclose(realized_angular / realized_linear, 1.0 / 0.9))

    def test_differential_without_track_width_is_blocked(self) -> None:
        command = twist_to_differential(0.5, 0.5, differential_limits(None))
        self.assertEqual(command.left, 0.0)
        self.assertEqual(command.right, 0.0)
        self.assertTrue(command.unconfigured_track_width)

    def test_differential_rejects_non_positive_track_width(self) -> None:
        with self.assertRaises(ValueError):
            twist_to_differential(0.5, 0.0, differential_limits(0.0))

    def test_watchdog_expires(self) -> None:
        watchdog = CommandWatchdog(0.35)
        self.assertTrue(watchdog.expired(0.0))
        watchdog.record(1.0)
        self.assertFalse(watchdog.expired(1.3))
        self.assertTrue(watchdog.expired(1.36))


if __name__ == "__main__":
    unittest.main()
