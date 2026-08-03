import unittest

from bbiyong_bringup.commissioning_model import (
    REQUIRED_ACTIONS,
    RUNTIME_LIFECYCLE_NODES,
    RUNTIME_NODES,
    evaluate_snapshot,
)


def healthy(mode):
    nodes = list(RUNTIME_NODES)
    lifecycle = {name: "active" for name in RUNTIME_LIFECYCLE_NODES}
    snapshot = {
        "nodes": nodes,
        "cmd_vel_publishers": ["/bbiyong_cmd_mux"],
        "map_odom_authorities": ["gid-a"],
        "lifecycle": lifecycle,
        "actions": list(REQUIRED_ACTIONS),
    }
    if mode == "mapping":
        nodes.append("slam_toolbox")
        snapshot["map_publishers"] = ["/slam_toolbox"]
        lifecycle["slam_toolbox"] = "active"
    else:
        nodes.extend(("map_server", "amcl", "bbiyong_scouting_guard"))
        snapshot.update({
            "map_publishers": ["/map_server"],
            "localization_pose_valid": True,
            "scouting_session_ready": True,
        })
        lifecycle.update({"map_server": "active", "amcl": "active"})
    return snapshot


class CommissioningModelTest(unittest.TestCase):
    def test_healthy_mapping_passes(self):
        self.assertTrue(evaluate_snapshot("mapping", healthy("mapping"))["ok"])

    def test_healthy_scouting_passes(self):
        self.assertTrue(evaluate_snapshot("scouting", healthy("scouting"))["ok"])

    def test_duplicate_runtime_and_final_publishers_fail(self):
        snapshot = healthy("mapping")
        snapshot["nodes"].append("bbiyong_cmd_mux")
        snapshot["cmd_vel_publishers"].append("legacy_teleop")
        report = evaluate_snapshot("mapping", snapshot)
        self.assertFalse(report["ok"])
        failed = {item["name"] for item in report["checks"] if not item["ok"]}
        self.assertIn("runtime node bbiyong_cmd_mux", failed)
        self.assertIn("final /cmd_vel publisher", failed)

    def test_mixed_map_providers_and_authorities_fail(self):
        snapshot = healthy("scouting")
        snapshot["nodes"].append("slam_toolbox")
        snapshot["map_publishers"].append("slam_toolbox")
        snapshot["map_odom_authorities"].append("gid-b")
        self.assertFalse(evaluate_snapshot("scouting", snapshot)["ok"])

    def test_scouting_requires_pose_and_fresh_guard_state(self):
        snapshot = healthy("scouting")
        snapshot["localization_pose_valid"] = False
        snapshot["scouting_session_ready"] = False
        self.assertFalse(evaluate_snapshot("scouting", snapshot)["ok"])


if __name__ == "__main__":
    unittest.main()
