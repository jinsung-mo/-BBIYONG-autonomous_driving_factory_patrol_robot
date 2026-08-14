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
    stop = load_yaml("collision_monitor.yaml")["collision_monitor"][
        "ros__parameters"
    ]
    slowdown = load_yaml("collision_slowdown_monitor.yaml")[
        "collision_slowdown_monitor"
    ]["ros__parameters"]
    assert slowdown["cmd_vel_in_topic"] == "/cmd_vel/autonomy_unfloored"
    assert slowdown["cmd_vel_out_topic"] == "/cmd_vel/autonomy_slowed"
    assert slowdown["scan"]["topic"] == "/scan_safety_confirmed"
    assert slowdown["slowdown_zone"]["max_points"] >= 3
    assert slowdown["slowdown_zone"]["slowdown_ratio"] >= 0.85
    assert slowdown["slowdown_zone"]["enabled"] is False
    slowdown_x = slowdown["slowdown_zone"]["points"][0::2]
    slowdown_y = slowdown["slowdown_zone"]["points"][1::2]
    assert min(slowdown_x) == 0.30
    assert max(slowdown_x) == 0.50
    assert min(slowdown_y) == -0.20
    assert max(slowdown_y) == 0.20
    assert stop["cmd_vel_in_topic"] == "/cmd_vel/autonomy_raw"
    assert stop["cmd_vel_out_topic"] == "/cmd_vel/autonomy"
    assert stop["scan"]["topic"] == "/scan_safety_body"
    assert stop["polygons"] == ["immediate_stop", "directional_approach"]
    immediate = stop["immediate_stop"]
    assert immediate["action_type"] == "stop"
    assert immediate["type"] == "circle"
    assert immediate["radius"] == 0.20
    assert immediate["max_points"] == 0
    approach = stop["directional_approach"]
    assert approach["action_type"] == "approach"
    assert approach["type"] == "circle"
    assert approach["radius"] == 0.30
    assert approach["max_points"] == 0
    assert approach["time_before_collision"] == 0.5
    assert approach["enabled"] is False


def test_safety_scan_filters_separate_stop_from_confirmed_slowdown() -> None:
    params = load_yaml("safety_scan_filter.yaml")
    body = params["safety_body_filter"]["ros__parameters"]["filter1"]
    speckle = params["safety_speckle_filter"]["ros__parameters"]["filter1"]
    assert body["type"] == "laser_filters/LaserScanBoxFilter"
    box = body["params"]
    assert -0.34 < box["min_x"] < box["max_x"] < 0.38
    assert -0.34 < box["min_y"] < box["max_y"] < 0.34
    assert speckle["type"] == "laser_filters/LaserScanSpeckleFilter"
    assert speckle["params"]["filter_window"] >= 3


def test_navigation_commits_path_and_wires_safety_chain() -> None:
    tree = (CONFIG / "navigate_to_pose_ackermann.xml").read_text(encoding="utf-8")
    launch = (LAUNCH / "navigation_core.launch.py").read_text(encoding="utf-8")
    assert "SequenceStar" in tree
    assert "RateController" not in tree
    assert 'number_of_retries="4"' in tree
    assert tree.count("<BackUp") == 2
    assert 'backup_dist="0.05"' in tree
    assert 'backup_speed="0.05"' in tree
    assert "<Spin" in tree
    assert 'spin_dist="1.57"' in tree
    assert '<Wait wait_duration="0.2"/>' in tree
    assert '"cmd_vel_smoothed", "/cmd_vel/autonomy_unfloored"' in launch
    assert '"input_topic": "/cmd_vel/autonomy_slowed"' in launch
    assert '"output_topic": "/cmd_vel/autonomy_raw"' in launch
    assert 'name="collision_slowdown_monitor"' in launch
    assert 'name="collision_monitor"' in launch
    assert '"default_nav_to_pose_bt_xml": committed_path_bt' in launch


def test_nav2_counts_rotation_as_progress_without_lengthening_timeout() -> None:
    progress = load_yaml("nav2_diff.yaml")["controller_server"][
        "ros__parameters"
    ]["progress_checker"]
    assert progress["plugin"] == "nav2_controller::PoseProgressChecker"
    assert 0.0 < progress["required_movement_angle"] <= 0.15
    assert progress["movement_time_allowance"] < 30.0


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
