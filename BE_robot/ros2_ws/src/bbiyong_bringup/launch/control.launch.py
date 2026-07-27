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
    drive_type = vehicle.get("drive_type")
    if hardware_enabled:
        if drive_type not in ("ackermann", "differential"):
            raise RuntimeError("hardware control implements Ackermann and differential drive only")
        strict = validate_vehicle_config(config, strict_hardware=True)
        if not strict.valid:
            raise RuntimeError("unsafe hardware configuration: " + "; ".join(strict.errors))
    # `or 0.0` keeps unmeasured (null) yaml entries out of the parameter server;
    # the adapters treat 0.0 as "not measured" and block their outputs.
    if drive_type == "differential":
        executable = "differential_adapter"
        parameter = {
            "hardware_enabled": hardware_enabled,
            "track_width_m": vehicle.get("track_width_m") or 0.0,
            "max_linear_speed_mps": vehicle.get("max_linear_speed_mps") or 0.1,
            "max_angular_speed_rps": vehicle.get("max_angular_speed_rps") or 0.3,
            "left_wheel_direction": float(vehicle.get("left_wheel_direction", 1)),
            "right_wheel_direction": float(vehicle.get("right_wheel_direction", 1)),
            "cmd_timeout_sec": vehicle.get("cmd_timeout_sec", 0.35),
        }
    else:
        executable = "ackermann_adapter"
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
        Node(package="bbiyong_base", executable=executable, output="screen", parameters=[parameter]),
    ]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument("vehicle_config"),
        OpaqueFunction(function=_control_nodes),
    ])
