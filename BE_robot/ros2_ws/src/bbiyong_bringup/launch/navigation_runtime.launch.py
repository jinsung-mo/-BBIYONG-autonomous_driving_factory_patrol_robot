from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    """Keep Nav2, the safety chain, and command arbitration alive between missions."""
    share = get_package_share_directory("bbiyong_bringup")
    return LaunchDescription([
        DeclareLaunchArgument(
            "nav2_params", default_value=f"{share}/config/nav2_diff.yaml"
        ),
        DeclareLaunchArgument(
            "collision_monitor_params",
            default_value=f"{share}/config/collision_monitor.yaml",
        ),
        DeclareLaunchArgument(
            "collision_slowdown_monitor_params",
            default_value=f"{share}/config/collision_slowdown_monitor.yaml",
        ),
        DeclareLaunchArgument(
            "safety_scan_filter_params",
            default_value=f"{share}/config/safety_scan_filter.yaml",
        ),
        DeclareLaunchArgument("log_level", default_value="info"),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                f"{share}/launch/navigation_core.launch.py"
            ),
            launch_arguments={
                "nav2_params": LaunchConfiguration("nav2_params"),
                "collision_monitor_params": LaunchConfiguration(
                    "collision_monitor_params"
                ),
                "collision_slowdown_monitor_params": LaunchConfiguration(
                    "collision_slowdown_monitor_params"
                ),
                "safety_scan_filter_params": LaunchConfiguration(
                    "safety_scan_filter_params"
                ),
                "log_level": LaunchConfiguration("log_level"),
            }.items(),
        ),
        # This runtime is the sole owner of the final /cmd_vel publisher.
        # Short-lived exploration and waypoint missions only submit actions.
        Node(
            package="bbiyong_base",
            executable="cmd_mux",
            name="bbiyong_cmd_mux",
            output="screen",
        ),
        Node(
            package="bbiyong_base",
            executable="control_state_bridge",
            name="bbiyong_control_state_bridge",
            output="screen",
        ),
        Node(
            package="bbiyong_base",
            executable="manual_drive_bridge",
            name="bbiyong_manual_drive_bridge",
            output="screen",
        ),
    ])
