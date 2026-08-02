from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    params = LaunchConfiguration("nav2_params")
    committed_path_bt = f"{share}/config/navigate_to_pose_ackermann.xml"
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
        "collision_slowdown_monitor",
        "collision_monitor",
    ]
    return LaunchDescription([
        DeclareLaunchArgument("nav2_params"),
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
        Node(
            package="nav2_bt_navigator",
            executable="bt_navigator",
            name="bt_navigator",
            output="screen",
            parameters=[
                params,
                {"default_nav_to_pose_bt_xml": committed_path_bt},
            ],
            arguments=[
                "--ros-args",
                "--log-level",
                LaunchConfiguration("log_level"),
            ],
        ),
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
                ("cmd_vel_smoothed", "/cmd_vel/autonomy_unfloored"),
            ],
            **common,
        ),
        Node(
            package="bbiyong_base",
            executable="velocity_floor",
            name="bbiyong_velocity_floor",
            output="screen",
            parameters=[{
                "input_topic": "/cmd_vel/autonomy_slowed",
                "output_topic": "/cmd_vel/autonomy_raw",
                "minimum_angular_speed": 0.42,
                "minimum_input_angular_speed": 0.05,
                "linear_epsilon": 0.01,
            }],
        ),
        Node(
            package="laser_filters",
            executable="scan_to_scan_filter_chain",
            name="safety_body_filter",
            output="screen",
            parameters=[LaunchConfiguration("safety_scan_filter_params")],
            remappings=[
                ("scan", "/scan_filtered"),
                ("scan_filtered", "/scan_safety_body"),
            ],
        ),
        Node(
            package="laser_filters",
            executable="scan_to_scan_filter_chain",
            name="safety_speckle_filter",
            output="screen",
            parameters=[LaunchConfiguration("safety_scan_filter_params")],
            remappings=[
                ("scan", "/scan_safety_body"),
                ("scan_filtered", "/scan_safety_confirmed"),
            ],
        ),
        Node(
            package="nav2_collision_monitor",
            executable="collision_monitor",
            name="collision_slowdown_monitor",
            output="screen",
            parameters=[
                LaunchConfiguration("collision_slowdown_monitor_params")
            ],
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
