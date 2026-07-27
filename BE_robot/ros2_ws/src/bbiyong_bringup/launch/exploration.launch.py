from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    explorer_share = get_package_share_directory("bbiyong_explorer")
    return LaunchDescription([
        DeclareLaunchArgument("vehicle_config", default_value=f"{share}/config/vehicle.example.yaml"),
        DeclareLaunchArgument("ydlidar_params", default_value=f"{share}/config/ydlidar.yaml"),
        DeclareLaunchArgument("slam_params", default_value=f"{share}/config/slam.yaml"),
        DeclareLaunchArgument("nav2_params", default_value=f"{share}/config/nav2_ackermann.template.yaml"),
        DeclareLaunchArgument("explorer_params", default_value=f"{explorer_share}/config/exploration.yaml"),
        DeclareLaunchArgument("map_output", default_value="~/maps/exploration_map"),
        DeclareLaunchArgument("odom_source", default_value="wheel"),
        DeclareLaunchArgument("start_lidar", default_value="true"),
        DeclareLaunchArgument("publish_laser_tf", default_value="true"),
        DeclareLaunchArgument("allow_unmeasured_lidar", default_value="false"),
        DeclareLaunchArgument("start_remote_control", default_value="false"),
        DeclareLaunchArgument("wss_url", default_value=""),
        DeclareLaunchArgument("robot_id", default_value="orinka_01"),
        DeclareLaunchArgument("remote_max_linear_mps", default_value="0.15"),
        DeclareLaunchArgument("remote_max_angular_rps", default_value="0.5"),
        DeclareLaunchArgument("remote_reconnect_sec", default_value="3.0"),
        DeclareLaunchArgument("remote_connect_timeout_sec", default_value="5.0"),
        DeclareLaunchArgument("remote_authorization_header", default_value=""),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(f"{share}/launch/mapping.launch.py"),
            launch_arguments={
                "vehicle_config": LaunchConfiguration("vehicle_config"),
                "ydlidar_params": LaunchConfiguration("ydlidar_params"),
                "slam_params": LaunchConfiguration("slam_params"),
                "odom_source": LaunchConfiguration("odom_source"),
                "start_lidar": LaunchConfiguration("start_lidar"),
                "publish_laser_tf": LaunchConfiguration("publish_laser_tf"),
                "allow_unmeasured_lidar": LaunchConfiguration("allow_unmeasured_lidar"),
            }.items(),
        ),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(f"{share}/launch/control.launch.py"),
            launch_arguments={
                "vehicle_config": LaunchConfiguration("vehicle_config"),
                "start_remote_control": LaunchConfiguration("start_remote_control"),
                "wss_url": LaunchConfiguration("wss_url"),
                "robot_id": LaunchConfiguration("robot_id"),
                "remote_max_linear_mps": LaunchConfiguration("remote_max_linear_mps"),
                "remote_max_angular_rps": LaunchConfiguration("remote_max_angular_rps"),
                "remote_reconnect_sec": LaunchConfiguration("remote_reconnect_sec"),
                "remote_connect_timeout_sec": LaunchConfiguration("remote_connect_timeout_sec"),
                "remote_authorization_header": LaunchConfiguration("remote_authorization_header"),
            }.items(),
        ),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(f"{share}/launch/navigation_core.launch.py"),
            launch_arguments={"nav2_params": LaunchConfiguration("nav2_params")}.items(),
        ),
        Node(
            package="bbiyong_explorer",
            executable="frontier_explorer",
            name="frontier_explorer",
            output="screen",
            parameters=[LaunchConfiguration("explorer_params")],
        ),
        Node(
            package="bbiyong_bringup",
            executable="exploration_map_saver",
            output="screen",
            parameters=[{"map_output": LaunchConfiguration("map_output"), "save_map_timeout": 10.0}],
        ),
    ])
