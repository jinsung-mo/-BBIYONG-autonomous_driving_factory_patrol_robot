from dataclasses import dataclass
from math import atan


@dataclass(frozen=True)
class VehicleLimits:
    wheelbase_m: float
    max_steering_angle_rad: float
    max_linear_speed_mps: float
    max_angular_speed_rps: float
    throttle_direction: float = 1.0
    steering_direction: float = 1.0
    stopped_speed_epsilon: float = 0.01

    def validate(self) -> None:
        positive = {
            "wheelbase_m": self.wheelbase_m,
            "max_steering_angle_rad": self.max_steering_angle_rad,
            "max_linear_speed_mps": self.max_linear_speed_mps,
            "max_angular_speed_rps": self.max_angular_speed_rps,
        }
        invalid = [name for name, value in positive.items() if value <= 0.0]
        if invalid:
            raise ValueError(f"vehicle parameters must be positive: {', '.join(invalid)}")
        if self.throttle_direction not in (-1.0, 1.0):
            raise ValueError("throttle_direction must be -1 or 1")
        if self.steering_direction not in (-1.0, 1.0):
            raise ValueError("steering_direction must be -1 or 1")


@dataclass(frozen=True)
class ActuatorCommand:
    throttle: float
    steering_angle_rad: float
    rejected_in_place_rotation: bool = False


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def twist_to_ackermann(linear_x: float, angular_z: float, limits: VehicleLimits) -> ActuatorCommand:
    """Convert Twist into normalized throttle and steering using the bicycle model.

    An Ackermann vehicle cannot rotate in place. A near-zero linear command with
    non-zero yaw is therefore rejected as a stop instead of producing an unsafe
    full-lock command.
    """
    limits.validate()
    linear_x = clamp(linear_x, -limits.max_linear_speed_mps, limits.max_linear_speed_mps)
    angular_z = clamp(angular_z, -limits.max_angular_speed_rps, limits.max_angular_speed_rps)

    if abs(linear_x) < limits.stopped_speed_epsilon:
        return ActuatorCommand(0.0, 0.0, abs(angular_z) >= limits.stopped_speed_epsilon)

    steering = atan(limits.wheelbase_m * angular_z / linear_x)
    steering = clamp(steering, -limits.max_steering_angle_rad, limits.max_steering_angle_rad)
    throttle = clamp(linear_x / limits.max_linear_speed_mps, -1.0, 1.0)
    return ActuatorCommand(
        throttle=throttle * limits.throttle_direction,
        steering_angle_rad=steering * limits.steering_direction,
    )
