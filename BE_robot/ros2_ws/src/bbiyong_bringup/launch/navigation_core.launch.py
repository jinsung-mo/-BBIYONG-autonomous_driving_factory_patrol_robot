from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    params = LaunchConfiguration("nav2_params")
    common = {
        "output": "screen",
        "parameters": [params],
        "arguments": ["--ros-args", "--log-level", LaunchConfiguration("log_level")],
    }
    lifecycle_nodes = [
        "controller_server",
        "smoother_server",
        "planner_server",
        "behavior_server",
        "bt_navigator",
        "waypoint_follower",
        "velocity_smoother",
        "collision_monitor",
    ]
    return LaunchDescription([
        DeclareLaunchArgument("nav2_params"),
        DeclareLaunchArgument(
            "collision_monitor_params",
            default_value=f"{share}/config/collision_monitor.yaml",
        ),
        DeclareLaunchArgument("log_level", default_value="info"),
        Node(
            package="nav2_controller",
            executable="controller_server",
            name="controller_server",
            remappings=[("cmd_vel", "cmd_vel_nav")],
            **common,
        ),
        Node(package="nav2_smoother", executable="smoother_server", name="smoother_server", **common),
        Node(package="nav2_planner", executable="planner_server", name="planner_server", **common),
        Node(
            package="nav2_behaviors",
            executable="behavior_server",
            name="behavior_server",
            remappings=[("cmd_vel", "cmd_vel_nav")],
            **common,
        ),
        Node(package="nav2_bt_navigator", executable="bt_navigator", name="bt_navigator", **common),
        Node(
            package="nav2_waypoint_follower",
            executable="waypoint_follower",
            name="waypoint_follower",
            **common,
        ),
        Node(
            package="nav2_velocity_smoother",
            executable="velocity_smoother",
            name="velocity_smoother",
            remappings=[
                ("cmd_vel", "cmd_vel_nav"),
                ("cmd_vel_smoothed", "/cmd_vel/autonomy_raw"),
            ],
            **common,
        ),
        Node(
            package="nav2_collision_monitor",
            executable="collision_monitor",
            name="collision_monitor",
            output="screen",
            parameters=[LaunchConfiguration("collision_monitor_params")],
        ),
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_navigation",
            output="screen",
            parameters=[{"autostart": True, "node_names": lifecycle_nodes}],
        ),
    ])
