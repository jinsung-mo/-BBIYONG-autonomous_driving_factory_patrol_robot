import argparse
from pathlib import Path

import yaml

from .vehicle_config import load_vehicle_config, validate_vehicle_config


def _set_costmap_geometry(costmap: dict, vehicle: dict) -> None:
    params = costmap["ros__parameters"]
    half_length = vehicle["length_m"] / 2.0
    half_width = vehicle["width_m"] / 2.0
    padding = vehicle.get("footprint_padding_m", 0.03)
    x = half_length + padding
    y = half_width + padding
    params.pop("robot_radius", None)
    params["footprint"] = f"[[{x}, {y}], [{x}, {-y}], [{-x}, {-y}], [{-x}, {y}]]"


def generate(vehicle_data: dict, template_data: dict, bt_xml_path: str | None = None) -> dict:
    result = validate_vehicle_config(vehicle_data, require_geometry=True)
    if not result.valid:
        raise ValueError("; ".join(result.errors))
    vehicle = vehicle_data["vehicle"]
    generated = template_data
    if bt_xml_path:
        generated["bt_navigator"]["ros__parameters"]["default_nav_to_pose_bt_xml"] = bt_xml_path
    _set_costmap_geometry(generated["local_costmap"]["local_costmap"], vehicle)
    _set_costmap_geometry(generated["global_costmap"]["global_costmap"], vehicle)

    controller = generated["controller_server"]["ros__parameters"]
    controller["FollowPath"]["desired_linear_vel"] = vehicle["max_linear_speed_mps"]
    controller["FollowPath"]["max_angular_accel"] = vehicle.get("max_angular_accel_rps2", 0.5)
    velocity_smoother = generated["velocity_smoother"]["ros__parameters"]
    velocity_smoother["max_velocity"][0] = vehicle["max_linear_speed_mps"]
    velocity_smoother["max_velocity"][2] = vehicle["max_angular_speed_rps"]
    velocity_smoother["min_velocity"][0] = -vehicle["max_linear_speed_mps"] / 2.0
    velocity_smoother["min_velocity"][2] = -vehicle["max_angular_speed_rps"]
    planner = generated["planner_server"]["ros__parameters"]["GridBased"]
    if vehicle["drive_type"] == "ackermann":
        planner["minimum_turning_radius"] = vehicle["min_turning_radius_m"]
    return generated


def main(args=None) -> None:
    parser = argparse.ArgumentParser(description="Generate Nav2 parameters from measured vehicle geometry")
    parser.add_argument("--vehicle", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--output", required=True)
    parsed = parser.parse_args(args)
    vehicle = load_vehicle_config(parsed.vehicle)
    with Path(parsed.template).open(encoding="utf-8") as stream:
        template = yaml.safe_load(stream)
    from ament_index_python.packages import get_package_share_directory

    bt_xml = str(
        Path(get_package_share_directory("bbiyong_bringup"))
        / "config"
        / "navigate_to_pose_ackermann.xml"
    )
    generated = generate(vehicle, template, bt_xml_path=bt_xml)
    output = Path(parsed.output).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as stream:
        yaml.safe_dump(generated, stream, sort_keys=False)
    print(output)
