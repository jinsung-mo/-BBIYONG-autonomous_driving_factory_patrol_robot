import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]


class NavigationMissionWiringTest(unittest.TestCase):
    def test_one_off_uses_nav2_action_and_never_velocity(self):
        source = (ROOT / "bbiyong_bringup" / "navigate_goal.py").read_text()
        self.assertIn("NavigateToPose", source)
        self.assertIn('ActionClient(self, NavigateToPose, "/navigate_to_pose")', source)
        self.assertIn("cancel_goal_async", source)
        self.assertIn("signal.SIGTERM", source)
        for state in ("ACCEPTED", "SUCCEEDED", "CANCELLED", "FAILED"):
            self.assertIn(f'"{state}"', source)
        self.assertNotIn("/cmd_vel", source)
        ast.parse(source)

    def test_patrol_route_replacement_requests_cancel(self):
        source = (ROOT / "bbiyong_bringup" / "patrol_route.py").read_text()
        self.assertIn('self._request_cancel("route replaced")', source)
        self.assertIn("current_waypoint", source)
        self.assertIn("missed_waypoints", source)
        self.assertIn("self.loop_route", source)
        self.assertIn("signal.SIGTERM", source)
        self.assertIn('declare_parameter("loop_route", False)', source)
        self.assertIn("scoutingSessionId", (
            ROOT.parents[2] / "orin_dashboard" / "navigation_orchestrator.py"
        ).read_text())

    def test_scouting_launch_does_not_start_sensors_or_slam(self):
        source = (ROOT / "launch" / "scouting_runtime.launch.py").read_text()
        self.assertIn("localization_launch.py", source)
        self.assertIn("navigation_runtime.launch.py", source)
        self.assertIn("scouting_guard", source)
        self.assertNotIn("sensors_odom.launch.py", source)
        self.assertNotIn("slam_toolbox", source)
        ast.parse(source)

    def test_scouting_guard_checks_all_authorities(self):
        source = (ROOT / "bbiyong_bringup" / "scouting_guard.py").read_text()
        for marker in ("get_publishers_info_by_topic", "map_odom_publishers", "pose_valid", "GetState"):
            self.assertIn(marker, source)


if __name__ == "__main__":
    unittest.main()
