from math import isclose, radians
import unittest

from bbiyong_base.kinematics import VehicleLimits, twist_to_ackermann
from bbiyong_base.safety import CommandWatchdog


def limits() -> VehicleLimits:
    return VehicleLimits(0.3, radians(30.0), 1.0, 1.0)


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

    def test_watchdog_expires(self) -> None:
        watchdog = CommandWatchdog(0.35)
        self.assertTrue(watchdog.expired(0.0))
        watchdog.record(1.0)
        self.assertFalse(watchdog.expired(1.3))
        self.assertTrue(watchdog.expired(1.36))


if __name__ == "__main__":
    unittest.main()
