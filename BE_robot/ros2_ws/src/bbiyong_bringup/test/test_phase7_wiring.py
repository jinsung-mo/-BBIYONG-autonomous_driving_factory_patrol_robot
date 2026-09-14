from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
WORKSPACE = ROOT.parents[1]


class Phase7WiringTest(unittest.TestCase):
    def test_commission_probe_is_observation_only(self):
        source = (ROOT / "bbiyong_bringup" / "commission_check.py").read_text()
        self.assertIn("create_subscription", source)
        self.assertIn("get_publishers_info_by_topic", source)
        self.assertNotIn("create_publisher", source)
        self.assertNotIn("send_goal_async", source)
        self.assertNotIn("publish(", source)

    def test_operator_commands_and_entry_points_are_installed(self):
        setup = (ROOT / "setup.py").read_text()
        script = (WORKSPACE / "scripts" / "bbiyong").read_text()
        for name in ("commission_check", "collect_evidence", "release_manager"):
            self.assertIn(f'"{name} = bbiyong_bringup.', setup)
        for command in ("commission-check)", "collect-evidence)", "release)"):
            self.assertIn(command, script)

    def test_untuned_collision_zones_remain_disabled(self):
        collision = (ROOT / "config" / "collision_monitor.yaml").read_text()
        slowdown = (ROOT / "config" / "collision_slowdown_monitor.yaml").read_text()
        directional = collision.split("directional_approach:", 1)[1]
        self.assertIn("enabled: false", directional)
        zone = slowdown.split("slowdown_zone:", 1)[1]
        self.assertIn("enabled: false", zone)

    def test_phase7_runbook_forbids_unattended_motion(self):
        runbook = (WORKSPACE / "docs" / "PHASE7_COMMISSIONING.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("No movement test may be run unattended over SSH", runbook)
        self.assertIn("--confirm-independent-stop", runbook)
        self.assertIn("7B (pending hardware)", runbook)


if __name__ == "__main__":
    unittest.main()
