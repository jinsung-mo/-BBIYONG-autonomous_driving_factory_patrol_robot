from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("bbiyong_inspection")
    return LaunchDescription([
        DeclareLaunchArgument(
            "params_file", default_value=f"{share}/config/inspection.yaml"
        ),
        Node(
            package="bbiyong_inspection",
            executable="apriltag_detector",
            name="bbiyong_apriltag_detector",
            output="screen",
            parameters=[LaunchConfiguration("params_file")],
        ),
        Node(
            package="bbiyong_inspection",
            executable="wall_ping_projector",
            name="bbiyong_wall_ping_projector",
            output="screen",
            parameters=[LaunchConfiguration("params_file")],
        ),
        Node(
            package="bbiyong_inspection",
            executable="inspection_point_manager",
            name="bbiyong_inspection_point_manager",
            output="screen",
            parameters=[LaunchConfiguration("params_file")],
        ),
        Node(
            package="bbiyong_inspection",
            executable="inspection_patrol",
            name="bbiyong_inspection_patrol",
            output="screen",
            parameters=[LaunchConfiguration("params_file")],
        ),
    ])
