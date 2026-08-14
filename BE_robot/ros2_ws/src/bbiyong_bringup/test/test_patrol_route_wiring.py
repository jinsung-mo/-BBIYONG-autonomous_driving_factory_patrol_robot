import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]


class PatrolRouteWiringTest(unittest.TestCase):
    def test_patrol_uses_follow_waypoints_and_never_cmd_vel(self):
        source = (ROOT / "bbiyong_bringup" / "patrol_route.py").read_text()
        self.assertIn("FollowWaypoints", source)
        self.assertIn('ActionClient(self, FollowWaypoints, "/follow_waypoints")', source)
        self.assertNotIn("/cmd_vel", source)
        ast.parse(source)

    def test_console_entry_and_dependencies_are_declared(self):
        setup = (ROOT / "setup.py").read_text()
        package = (ROOT / "package.xml").read_text()
        self.assertIn("patrol_route = bbiyong_bringup.patrol_route:main", setup)
        self.assertIn("navigate_goal = bbiyong_bringup.navigate_goal:main", setup)
        self.assertIn("scouting_guard = bbiyong_bringup.scouting_guard:main", setup)
        for dependency in ("action_msgs", "geometry_msgs", "nav2_msgs"):
            self.assertIn(f"<exec_depend>{dependency}</exec_depend>", package)


if __name__ == "__main__":
    unittest.main()
