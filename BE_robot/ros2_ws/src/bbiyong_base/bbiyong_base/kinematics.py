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
    # Differential drive only. None means "not measured yet" and is the expected
    # value until the track width is taken off the real chassis; the kinematics
    # then refuse to produce any wheel command. Never give this a numeric default.
    track_width_m: float | None = None
    left_wheel_direction: float = 1.0
    right_wheel_direction: float = 1.0

    @classmethod
    def for_differential(
        cls,
        max_linear_speed_mps: float,
        max_angular_speed_rps: float,
        track_width_m: float | None = None,
        left_wheel_direction: float = 1.0,
        right_wheel_direction: float = 1.0,
    ) -> "VehicleLimits":
        """Build limits for a differential base. wheelbase/steering are Ackermann-only."""
        return cls(
            wheelbase_m=0.0,
            max_steering_angle_rad=0.0,
            max_linear_speed_mps=max_linear_speed_mps,
            max_angular_speed_rps=max_angular_speed_rps,
            track_width_m=track_width_m,
            left_wheel_direction=left_wheel_direction,
            right_wheel_direction=right_wheel_direction,
        )

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

    def validate_differential(self) -> None:
        """Validate the subset a differential base uses.

        wheelbase_m and max_steering_angle_rad are deliberately not checked: a
        differential base has no steered axle. An unmeasured track width
        (None) is not an error here - it is handled by twist_to_differential,
        which then blocks the output instead of guessing a value.
        """
        positive = {
            "max_linear_speed_mps": self.max_linear_speed_mps,
            "max_angular_speed_rps": self.max_angular_speed_rps,
        }
        invalid = [name for name, value in positive.items() if value <= 0.0]
        if invalid:
            raise ValueError(f"vehicle parameters must be positive: {', '.join(invalid)}")
        if self.track_width_m is not None and self.track_width_m <= 0.0:
            raise ValueError("track_width_m must be positive when it is set")
        if self.left_wheel_direction not in (-1.0, 1.0):
            raise ValueError("left_wheel_direction must be -1 or 1")
        if self.right_wheel_direction not in (-1.0, 1.0):
            raise ValueError("right_wheel_direction must be -1 or 1")


@dataclass(frozen=True)
class ActuatorCommand:
    throttle: float
    steering_angle_rad: float
    rejected_in_place_rotation: bool = False


@dataclass(frozen=True)
class DifferentialCommand:
    """Wheel command pair.

    left/right are the values actually published: normalized to [-1, 1] on the
    same scale as ActuatorCommand.throttle, where 1.0 means max_linear_speed_mps.
    left_mps/right_mps carry the same command in SI units and are kept so the
    scale-down can be reasoned about (and asserted) in physical terms, and so a
    future closed-loop firmware can consume m/s without touching this math.
    """

    left: float
    right: float
    left_mps: float = 0.0
    right_mps: float = 0.0
    scaled_to_limit: bool = False
    unconfigured_track_width: bool = False


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

def twist_to_differential(
    linear_x: float, angular_z: float, limits: VehicleLimits
) -> DifferentialCommand:
    """Convert Twist into a normalized left/right wheel command pair.

    Unit of the returned left/right: normalized [-1, 1], where 1.0 means
    max_linear_speed_mps, i.e. the exact same scale ActuatorCommand.throttle
    already uses. Reasons for not returning m/s or rad/s here:
      * m/s or rad/s only becomes a real setpoint once wheel_radius_m and
        encoder_cpr are measured; both are still null in vehicle.yaml, so
        publishing SI units today would force a made-up constant somewhere.
      * The ESP32 drives an MDD10A with PWM duty + DIR. A normalized value maps
        to |value| -> duty and sign -> DIR with a single calibration number,
        and that number is the same one the throttle topic already needs.
      * left_mps/right_mps are still returned, so switching to a closed-loop
        m/s contract later is a publisher change, not a kinematics change.

    A differential base has no steered axle, so rotating in place is a normal
    command and is not rejected (unlike twist_to_ackermann).
    """
    limits.validate_differential()
    if limits.track_width_m is None:
        # Track width has not been measured. Guessing it would silently scale
        # every rotation command, so the output is blocked instead.
        return DifferentialCommand(0.0, 0.0, unconfigured_track_width=True)

    linear_x = clamp(linear_x, -limits.max_linear_speed_mps, limits.max_linear_speed_mps)
    angular_z = clamp(angular_z, -limits.max_angular_speed_rps, limits.max_angular_speed_rps)

    half_track = limits.track_width_m / 2.0
    left_mps = linear_x - angular_z * half_track
    right_mps = linear_x + angular_z * half_track

    # Both wheels are scaled by the same factor when either one exceeds the
    # limit. Clipping only the faster wheel would change the ratio between the
    # two wheels, and that ratio is the path curvature: the robot would drive a
    # different arc than the one commanded. A common factor k gives
    # v' = k*v and w' = k*w, so w'/v' = w/v - the arc is preserved and only the
    # speed along it drops.
    peak = max(abs(left_mps), abs(right_mps))
    scaled_to_limit = peak > limits.max_linear_speed_mps
    if scaled_to_limit:
        factor = limits.max_linear_speed_mps / peak
        left_mps *= factor
        right_mps *= factor

    return DifferentialCommand(
        left=clamp(left_mps / limits.max_linear_speed_mps, -1.0, 1.0)
        * limits.left_wheel_direction,
        right=clamp(right_mps / limits.max_linear_speed_mps, -1.0, 1.0)
        * limits.right_wheel_direction,
        left_mps=left_mps,
        right_mps=right_mps,
        scaled_to_limit=scaled_to_limit,
    )

