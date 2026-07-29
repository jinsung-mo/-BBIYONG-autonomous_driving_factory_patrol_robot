from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    nav2_share = get_package_share_directory("nav2_bringup")
    return LaunchDescription([
        DeclareLaunchArgument("map", description="absolute path to saved map YAML"),
        DeclareLaunchArgument("vehicle_config", default_value=f"{share}/config/vehicle.example.yaml"),
        DeclareLaunchArgument("ydlidar_params", default_value=f"{share}/config/ydlidar.yaml"),
        DeclareLaunchArgument("scan_filter_params", default_value=f"{share}/config/scan_filter.yaml"),
        DeclareLaunchArgument("nav2_params", default_value=f"{share}/config/nav2_ackermann.template.yaml"),
        DeclareLaunchArgument("odom_source", default_value="rf2o"),
        DeclareLaunchArgument("start_lidar", default_value="true"),
        DeclareLaunchArgument("start_scan_filter", default_value="true"),
        DeclareLaunchArgument("publish_scan_compat", default_value="true"),
        DeclareLaunchArgument("publish_laser_tf", default_value="true"),
        DeclareLaunchArgument("allow_unmeasured_lidar", default_value="false"),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(f"{share}/launch/sensors_odom.launch.py"),
            launch_arguments={
                "vehicle_config": LaunchConfiguration("vehicle_config"),
                "ydlidar_params": LaunchConfiguration("ydlidar_params"),
                "scan_filter_params": LaunchConfiguration("scan_filter_params"),
                "odom_source": LaunchConfiguration("odom_source"),
                "start_lidar": LaunchConfiguration("start_lidar"),
                "start_scan_filter": LaunchConfiguration("start_scan_filter"),
                "publish_scan_compat": LaunchConfiguration("publish_scan_compat"),
                "publish_laser_tf": LaunchConfiguration("publish_laser_tf"),
                "allow_unmeasured_lidar": LaunchConfiguration("allow_unmeasured_lidar"),
            }.items(),
        ),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(f"{nav2_share}/launch/localization_launch.py"),
            launch_arguments={
                "map": LaunchConfiguration("map"),
                "params_file": LaunchConfiguration("nav2_params"),
                "use_sim_time": "false",
                "use_composition": "False",
                "autostart": "true",
            }.items(),
        ),
    ])
