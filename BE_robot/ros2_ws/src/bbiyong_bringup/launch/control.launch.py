from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

from bbiyong_bringup.vehicle_config import load_vehicle_config, validate_vehicle_config


def _control_nodes(context):
    config = load_vehicle_config(LaunchConfiguration("vehicle_config").perform(context))
    vehicle = config["vehicle"]
    result = validate_vehicle_config(config, strict_hardware=False)
    if not result.valid:
        raise RuntimeError("; ".join(result.errors))
    hardware_enabled = vehicle.get("hardware_enabled") is True
    if hardware_enabled:
        if vehicle.get("drive_type") != "ackermann":
            raise RuntimeError("hardware control currently implements Ackermann drive only")
        strict = validate_vehicle_config(config, strict_hardware=True)
        if not strict.valid:
            raise RuntimeError("unsafe hardware configuration: " + "; ".join(strict.errors))
    parameter = {
        "hardware_enabled": hardware_enabled,
        "wheelbase_m": vehicle.get("wheelbase_m") or 0.0,
        "max_steering_angle_deg": vehicle.get("max_steering_angle_deg") or 0.0,
        "max_linear_speed_mps": vehicle.get("max_linear_speed_mps") or 0.1,
        "max_angular_speed_rps": vehicle.get("max_angular_speed_rps") or 0.3,
        "throttle_direction": float(vehicle.get("throttle_direction", 1)),
        "steering_direction": float(vehicle.get("steering_direction", 1)),
        "cmd_timeout_sec": vehicle.get("cmd_timeout_sec", 0.35),
    }
    return [
        Node(package="bbiyong_base", executable="cmd_mux", output="screen"),
        Node(package="bbiyong_base", executable="ackermann_adapter", output="screen", parameters=[parameter]),
    ]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument("vehicle_config"),
        OpaqueFunction(function=_control_nodes),
    ])
