from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import LifecycleNode, Node

from bbiyong_bringup.vehicle_config import (
    load_vehicle_config,
    validate_vehicle_config,
    validate_wheel_odometry,
)


def _configured_nodes(context):
    config = load_vehicle_config(LaunchConfiguration("vehicle_config").perform(context))
    validation = validate_vehicle_config(config)
    if not validation.valid:
        raise RuntimeError("; ".join(validation.errors))
    odom_source = LaunchConfiguration("odom_source").perform(context)
    if odom_source not in {"rf2o", "wheel"}:
        raise RuntimeError("odom_source must be rf2o or wheel")
    if odom_source == "wheel":
        wheel_validation = validate_wheel_odometry(config)
        if not wheel_validation.valid:
            raise RuntimeError("; ".join(wheel_validation.errors))
    lidar = config["lidar"]
    pose_keys = ("x_m", "y_m", "z_m", "roll_rad", "pitch_rad", "yaw_rad")
    values = [lidar.get(key) for key in pose_keys]
    allow = LaunchConfiguration("allow_unmeasured_lidar").perform(context).lower() == "true"
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in values):
        if not allow:
            raise RuntimeError("measure lidar pose in vehicle.yaml or use allow_unmeasured_lidar:=true for bench mapping")
        values = [
            0.0
            if not isinstance(value, (int, float)) or isinstance(value, bool)
            else value
            for value in values
        ]

    x, y, z, roll, pitch, yaw = values
    nodes = [
        Node(
            package="tf2_ros",
            executable="static_transform_publisher",
            name="base_to_laser_tf",
            arguments=[
                "--x", str(x), "--y", str(y), "--z", str(z),
                "--roll", str(roll), "--pitch", str(pitch), "--yaw", str(yaw),
                "--frame-id", "base_link", "--child-frame-id", "laser_frame",
            ],
            condition=IfCondition(LaunchConfiguration("publish_laser_tf")),
        )
    ]
    if odom_source == "rf2o":
        nodes.append(
            Node(
                package="rf2o_laser_odometry",
                executable="rf2o_laser_odometry_node",
                name="rf2o_laser_odometry",
                output="screen",
                parameters=[{
                    "laser_scan_topic": "/scan",
                    "odom_topic": "/odom",
                    "publish_tf": True,
                    "base_frame_id": "base_link",
                    "odom_frame_id": "odom",
                    "init_pose_from_topic": "",
                    "freq": 10.0,
                }],
            )
        )
    return nodes


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    return LaunchDescription([
        DeclareLaunchArgument("vehicle_config", default_value=f"{share}/config/vehicle.example.yaml"),
        DeclareLaunchArgument("ydlidar_params", default_value=f"{share}/config/ydlidar.yaml"),
        DeclareLaunchArgument("odom_source", default_value="rf2o"),
        DeclareLaunchArgument("start_lidar", default_value="true"),
        DeclareLaunchArgument("publish_laser_tf", default_value="true"),
        DeclareLaunchArgument("allow_unmeasured_lidar", default_value="false"),
        LifecycleNode(
            package="ydlidar_ros2_driver",
            executable="ydlidar_ros2_driver_node",
            namespace="/",
            name="ydlidar_ros2_driver_node",
            output="screen",
            emulate_tty=True,
            parameters=[LaunchConfiguration("ydlidar_params")],
            condition=IfCondition(LaunchConfiguration("start_lidar")),
        ),
        OpaqueFunction(function=_configured_nodes),
    ])
