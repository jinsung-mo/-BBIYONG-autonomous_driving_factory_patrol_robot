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
        # ~/calib/stack_up.sh is the sole owner of LiDAR, scan filtering,
        # odometry/TF, the ESP32 motor bridge, and slam_toolbox.  Do not include
        # mapping.launch.py here: duplicate publishers corrupt TF and mapping.
        DeclareLaunchArgument("nav2_params", default_value=f"{share}/config/nav2_diff.yaml"),
        DeclareLaunchArgument(
            "explorer_params",
            default_value=f"{explorer_share}/config/exploration.yaml",
        ),
        DeclareLaunchArgument(
            "collision_monitor_params",
            default_value=f"{share}/config/collision_monitor.yaml",
        ),
        DeclareLaunchArgument("map_output", default_value="~/maps/exploration_map"),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(f"{share}/launch/navigation_core.launch.py"),
            launch_arguments={
                "nav2_params": LaunchConfiguration("nav2_params"),
                "collision_monitor_params": LaunchConfiguration(
                    "collision_monitor_params"
                ),
            }.items(),
        ),
        # Collision Monitor publishes safe autonomy commands to this mux.  The
        # mux is the only /cmd_vel publisher; stack_up.sh's esp32_base_node.py
        # consumes /cmd_vel and retains its independent 0.5 s motor watchdog.
        Node(
            package="bbiyong_base",
            executable="cmd_mux",
            name="bbiyong_cmd_mux",
            output="screen",
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
            parameters=[
                {
                    "map_output": LaunchConfiguration("map_output"),
                    "save_map_timeout": 10.0,
                }
            ],
        ),
    ])
