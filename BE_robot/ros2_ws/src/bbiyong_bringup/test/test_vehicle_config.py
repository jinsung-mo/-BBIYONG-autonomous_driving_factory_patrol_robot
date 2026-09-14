import unittest
from pathlib import Path
import xml.etree.ElementTree as element_tree

import yaml

from bbiyong_bringup.generate_nav2_config import generate
from bbiyong_bringup.vehicle_config import validate_vehicle_config, validate_wheel_odometry


def valid_vehicle() -> dict:
    return {
        "vehicle": {
            "configured": True,
            "hardware_enabled": True,
            "drive_type": "ackermann",
            "base_link_reference": "geometric_center",
            "wheelbase_m": 0.3,
            "width_m": 0.25,
            "length_m": 0.4,
            "max_steering_angle_deg": 30.0,
            "min_turning_radius_m": 0.52,
            "max_linear_speed_mps": 0.1,
            "max_angular_speed_rps": 0.3,
        },
        "lidar": {
            "frame_id": "laser_frame", "range_max_m": 10.0,
            "x_m": 0.0, "y_m": 0.0, "z_m": 0.2,
            "roll_rad": 0.0, "pitch_rad": 0.0, "yaw_rad": 0.0,
        },
        "wheel_odometry": {
            "configured": True,
            "wheel_radius_m": 0.05,
            "encoder_cpr": 1024,
            "publish_tf": True,
        },
    }


class VehicleConfigTest(unittest.TestCase):
    def test_unconfigured_is_allowed_only_for_dry_run(self) -> None:
        data = valid_vehicle()
        data["vehicle"]["configured"] = False
        data["vehicle"]["hardware_enabled"] = False
        self.assertTrue(validate_vehicle_config(data).valid)
        self.assertFalse(validate_vehicle_config(data, strict_hardware=True).valid)

    def test_missing_wheelbase_is_rejected(self) -> None:
        data = valid_vehicle()
        data["vehicle"]["wheelbase_m"] = None
        self.assertFalse(validate_vehicle_config(data, strict_hardware=True).valid)

    def test_generator_rejects_unmeasured_vehicle(self) -> None:
        data = valid_vehicle()
        data["vehicle"]["configured"] = False
        with self.assertRaises(ValueError):
            generate(data, {})

    def test_measured_vehicle_can_generate_before_hardware_enable(self) -> None:
        data = valid_vehicle()
        data["vehicle"]["hardware_enabled"] = False
        self.assertTrue(validate_vehicle_config(data, require_geometry=True).valid)

    def test_unconfigured_wheel_odometry_is_rejected(self) -> None:
        data = valid_vehicle()
        data["wheel_odometry"]["configured"] = False
        self.assertFalse(validate_wheel_odometry(data).valid)

    def test_impossible_turning_radius_is_rejected(self) -> None:
        data = valid_vehicle()
        data["vehicle"]["min_turning_radius_m"] = 0.1
        self.assertFalse(validate_vehicle_config(data, require_geometry=True).valid)

    def test_generator_sets_ackermann_bt_and_footprint(self) -> None:
        package_root = Path(__file__).parents[1]
        template = yaml.safe_load(
            (package_root / "config" / "nav2_ackermann.template.yaml").read_text()
        )
        data = valid_vehicle()
        data["vehicle"]["hardware_enabled"] = False
        generated = generate(data, template, "/share/navigate_to_pose_ackermann.xml")
        self.assertEqual(
            generated["bt_navigator"]["ros__parameters"]["default_nav_to_pose_bt_xml"],
            "/share/navigate_to_pose_ackermann.xml",
        )
        footprint = generated["local_costmap"]["local_costmap"]["ros__parameters"][
            "footprint"
        ]
        self.assertIn("0.23", footprint)

    def test_ackermann_bt_xml_is_well_formed(self) -> None:
        xml_path = Path(__file__).parents[1] / "config" / "navigate_to_pose_ackermann.xml"
        element_tree.parse(xml_path)


if __name__ == "__main__":
    unittest.main()
