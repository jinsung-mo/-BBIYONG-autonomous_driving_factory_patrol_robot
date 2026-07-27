from pathlib import Path

import yaml


PACKAGE_ROOT = Path(__file__).parents[1]
CONFIG = PACKAGE_ROOT / "config"
LAUNCH = PACKAGE_ROOT / "launch"


def load_yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG / name).read_text(encoding="utf-8"))


def test_filter_chain_is_conservative_and_keeps_indexing() -> None:
    params = load_yaml("scan_filter.yaml")["scan_to_scan_filter_chain"][
        "ros__parameters"
    ]
    types = [params[key]["type"] for key in sorted(params)]
    assert types == [
        "laser_filters/LaserScanRangeFilter",
        "laser_filters/LaserScanAngularBoundsFilterInPlace",
    ]
    assert not any("Median" in plugin or "Interpolation" in plugin for plugin in types)
    angular = params["filter2"]["params"]
    assert angular["lower_angle"] < angular["upper_angle"]


def test_slam_and_nav2_use_only_filtered_scan() -> None:
    slam = load_yaml("slam.yaml")["slam_toolbox"]["ros__parameters"]
    assert slam["scan_topic"] == "/scan_filtered"
    for name in ("nav2_diff.yaml", "nav2_ackermann.template.yaml"):
        nav2 = load_yaml(name)
        assert nav2["amcl"]["ros__parameters"]["scan_topic"] == "/scan_filtered"
        for costmap_name in ("local_costmap", "global_costmap"):
            params = nav2[costmap_name][costmap_name]["ros__parameters"]
            assert params["plugins"].index("denoise_layer") < params["plugins"].index(
                "inflation_layer"
            )
            assert (
                params["obstacle_layer"]["scan"]["topic"] == "/scan_filtered"
            )


def test_collision_monitor_guards_autonomy_output() -> None:
    params = load_yaml("collision_monitor.yaml")["collision_monitor"][
        "ros__parameters"
    ]
    assert params["cmd_vel_in_topic"] == "/cmd_vel/autonomy_raw"
    assert params["cmd_vel_out_topic"] == "/cmd_vel/autonomy"
    assert params["scan"]["topic"] == "/scan_filtered"
    assert {"stop_zone", "slowdown_zone"} == set(params["polygons"])


def test_sensor_launch_preserves_raw_scan() -> None:
    source = (LAUNCH / "sensors_odom.launch.py").read_text(encoding="utf-8")
    assert '("scan", "/scan_raw")' in source
    assert '("scan_filtered", "/scan_filtered")' in source
    assert 'arguments=["/scan_filtered", "/scan"]' in source


def test_ydlidar_uses_ros_counter_clockwise_angles() -> None:
    params = load_yaml("ydlidar.yaml")["ydlidar_ros2_driver_node"][
        "ros__parameters"
    ]
    assert params["inverted"] is True
    assert params["reversion"] is False
