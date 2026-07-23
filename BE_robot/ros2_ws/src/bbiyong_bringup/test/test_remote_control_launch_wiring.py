import unittest
from pathlib import Path


class RemoteControlLaunchWiringTest(unittest.TestCase):
    def test_navigation_and_exploration_forward_all_remote_arguments(self) -> None:
        launch_dir = Path(__file__).parents[1] / "launch"
        expected = (
            "start_remote_control",
            "wss_url",
            "robot_id",
            "remote_max_linear_mps",
            "remote_max_angular_rps",
            "remote_reconnect_sec",
            "remote_connect_timeout_sec",
            "remote_authorization_header",
        )
        for launch_name in ("navigation.launch.py", "exploration.launch.py"):
            source = (launch_dir / launch_name).read_text()
            with self.subTest(launch_name=launch_name):
                self.assertIn('launch/control.launch.py', source)
                for argument in expected:
                    self.assertGreaterEqual(source.count(f'"{argument}"'), 2)


if __name__ == "__main__":
    unittest.main()
