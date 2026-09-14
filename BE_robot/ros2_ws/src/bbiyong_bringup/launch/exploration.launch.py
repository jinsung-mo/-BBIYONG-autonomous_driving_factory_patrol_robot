from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, Shutdown
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    explorer_share = get_package_share_directory("bbiyong_explorer")
    return LaunchDescription([
        # Mission-only launch. navigation_runtime.launch.py owns Nav2, the
        # collision/smoothing chain, and bbiyong_cmd_mux across repeated runs.
        # Keep the former runtime arguments accepted during a staged rollout;
        # they are intentionally unused by this mission launch.
        DeclareLaunchArgument(
            "nav2_params",
            default_value="",
            description="deprecated: configure navigation_runtime.launch.py",
        ),
        DeclareLaunchArgument(
            "collision_monitor_params",
            default_value="",
            description="deprecated: configure navigation_runtime.launch.py",
        ),
        DeclareLaunchArgument(
            "explorer_params",
            default_value=f"{explorer_share}/config/exploration.yaml",
        ),
        DeclareLaunchArgument("map_output", default_value="~/maps/exploration_map"),
        Node(
            package="bbiyong_explorer",
            executable="frontier_explorer",
            name="frontier_explorer",
            output="screen",
            parameters=[LaunchConfiguration("explorer_params")],
            # A rejected duplicate or crash shuts down this mission only. The
            # persistent Nav2/safety runtime remains available for another run.
            on_exit=Shutdown(reason="frontier explorer exited"),
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
            # Saver exit is the authoritative end of this mission, not of the
            # independently launched navigation runtime.
            on_exit=Shutdown(reason="exploration map saver finished"),
        ),
    ])
