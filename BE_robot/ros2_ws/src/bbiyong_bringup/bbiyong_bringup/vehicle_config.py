import argparse
from dataclasses import dataclass
from math import radians, tan
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ValidationResult:
    errors: tuple[str, ...]
    warnings: tuple[str, ...]

    @property
    def valid(self) -> bool:
        return not self.errors


def load_vehicle_config(path: str | Path) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as stream:
        data = yaml.safe_load(stream)
    if not isinstance(data, dict):
        raise ValueError("vehicle config root must be a mapping")
    return data


def _positive(data: dict[str, Any], key: str, errors: list[str]) -> None:
    value = data.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        errors.append(f"{key} must be a positive number")


def validate_wheel_odometry(data: dict[str, Any]) -> ValidationResult:
    errors: list[str] = []
    odometry = data.get("wheel_odometry")
    if not isinstance(odometry, dict):
        return ValidationResult(("wheel_odometry section is required",), ())
    if odometry.get("configured") is not True:
        errors.append("wheel_odometry.configured must be true for odom_source=wheel")
    _positive(odometry, "wheel_radius_m", errors)
    encoder_cpr = odometry.get("encoder_cpr")
    if not isinstance(encoder_cpr, int) or isinstance(encoder_cpr, bool) or encoder_cpr <= 0:
        errors.append("wheel_odometry.encoder_cpr must be a positive integer")
    if odometry.get("publish_tf") is not True:
        errors.append("wheel odometry must publish odom -> base_link TF")
    return ValidationResult(tuple(errors), ())


def validate_vehicle_config(
    data: dict[str, Any],
    strict_hardware: bool = False,
    require_geometry: bool = False,
) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []
    vehicle = data.get("vehicle")
    lidar = data.get("lidar")
    if not isinstance(vehicle, dict):
        return ValidationResult(("vehicle section is required",), ())
    if not isinstance(lidar, dict):
        return ValidationResult(("lidar section is required",), ())

    if vehicle.get("drive_type") not in {"ackermann", "differential"}:
        errors.append("vehicle.drive_type must be ackermann or differential")
    if lidar.get("frame_id") != "laser_frame":
        errors.append("lidar.frame_id must be laser_frame")
    _positive(lidar, "range_max_m", errors)

    pose_keys = ("x_m", "y_m", "z_m", "roll_rad", "pitch_rad", "yaw_rad")
    missing_pose = [
        key
        for key in pose_keys
        if not isinstance(lidar.get(key), (int, float)) or isinstance(lidar.get(key), bool)
    ]
    if missing_pose:
        message = "lidar pose is not measured: " + ", ".join(missing_pose)
        if strict_hardware or require_geometry:
            errors.append(message)
        else:
            warnings.append(message)

    configured = vehicle.get("configured") is True
    hardware_enabled = vehicle.get("hardware_enabled") is True
    if strict_hardware or hardware_enabled or require_geometry:
        if not configured:
            errors.append("vehicle.configured must be true before hardware control")
        if vehicle.get("base_link_reference") != "geometric_center":
            errors.append("vehicle.base_link_reference must be geometric_center")
        for key in ("wheelbase_m", "width_m", "length_m", "max_linear_speed_mps", "max_angular_speed_rps"):
            _positive(vehicle, key, errors)
        if vehicle.get("drive_type") == "ackermann":
            _positive(vehicle, "max_steering_angle_deg", errors)
            _positive(vehicle, "min_turning_radius_m", errors)
            wheelbase = vehicle.get("wheelbase_m")
            steering_degrees = vehicle.get("max_steering_angle_deg")
            turning_radius = vehicle.get("min_turning_radius_m")
            if all(
                isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
                for value in (wheelbase, steering_degrees, turning_radius)
            ) and steering_degrees < 90.0:
                physical_minimum = wheelbase / tan(radians(steering_degrees))
                if turning_radius < physical_minimum * 0.9:
                    errors.append(
                        "vehicle.min_turning_radius_m is smaller than the bicycle-model limit"
                    )
        if strict_hardware and not hardware_enabled:
            errors.append("vehicle.hardware_enabled must be true for strict hardware validation")
    elif not configured:
        warnings.append("vehicle is unconfigured; only mapping/localization dry-run is allowed")

    return ValidationResult(tuple(errors), tuple(warnings))


def main(args=None) -> None:
    parser = argparse.ArgumentParser(description="Validate BBIYONG vehicle configuration")
    parser.add_argument("config")
    parser.add_argument("--strict-hardware", action="store_true")
    parsed = parser.parse_args(args)
    result = validate_vehicle_config(load_vehicle_config(parsed.config), parsed.strict_hardware)
    for warning in result.warnings:
        print(f"WARNING: {warning}")
    for error in result.errors:
        print(f"ERROR: {error}")
    if not result.valid:
        raise SystemExit(2)
    print("vehicle config is valid")
