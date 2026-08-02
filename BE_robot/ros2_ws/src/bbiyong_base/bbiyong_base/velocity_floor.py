"""Pure velocity-command shaping used by the ROS node and unit tests."""

from __future__ import annotations


def enforce_in_place_rotation_floor(
    linear_x: float,
    angular_z: float,
    *,
    minimum_angular_speed: float,
    minimum_input_angular_speed: float,
    linear_epsilon: float,
) -> tuple[float, float]:
    """Raise a deliberate in-place turn above the chassis static-friction band."""
    if (
        abs(linear_x) <= linear_epsilon
        and minimum_input_angular_speed <= abs(angular_z) < minimum_angular_speed
    ):
        angular_z = minimum_angular_speed if angular_z > 0.0 else -minimum_angular_speed
    return linear_x, angular_z
