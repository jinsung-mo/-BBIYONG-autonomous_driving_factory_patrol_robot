from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, Shutdown
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    nav2_share = get_package_share_directory("nav2_bringup")
    return LaunchDescription([
        DeclareLaunchArgument("map", description="absolute saved-map YAML path"),
        DeclareLaunchArgument("nav2_params", default_value=f"{share}/config/nav2_diff.yaml"),
        DeclareLaunchArgument("start_navigation_runtime", default_value="true"),
        DeclareLaunchArgument(
            "scouting_state_file", default_value="/tmp/bbiyong_scouting_session.json"
        ),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                f"{nav2_share}/launch/localization_launch.py"
            ),
            launch_arguments={
                "map": LaunchConfiguration("map"),
                "params_file": LaunchConfiguration("nav2_params"),
                "use_sim_time": "false",
                "use_composition": "False",
                "autostart": "true",
            }.items(),
        ),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                f"{share}/launch/navigation_runtime.launch.py"
            ),
            condition=IfCondition(LaunchConfiguration("start_navigation_runtime")),
            launch_arguments={
                "nav2_params": LaunchConfiguration("nav2_params"),
            }.items(),
        ),
        Node(
            package="bbiyong_bringup",
            executable="scouting_guard",
            name="bbiyong_scouting_guard",
            output="screen",
            parameters=[{
                "map_file": LaunchConfiguration("map"),
                "state_file": LaunchConfiguration("scouting_state_file"),
            }],
            on_exit=Shutdown(reason="scouting readiness guard exited"),
        ),
    ])
