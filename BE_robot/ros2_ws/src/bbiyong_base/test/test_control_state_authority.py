import ast
from pathlib import Path
import unittest


PACKAGE = Path(__file__).resolve().parents[1]


class ControlStateAuthorityTest(unittest.TestCase):
    def test_bridge_is_the_only_state_publisher(self) -> None:
        bridge = (
            PACKAGE / "bbiyong_base" / "control_state_bridge.py"
        ).read_text(encoding="utf-8")
        command = (
            PACKAGE / "bbiyong_base" / "control_command.py"
        ).read_text(encoding="utf-8")

        self.assertIn('"/bbiyong/control_mode"', bridge)
        self.assertIn('"/bbiyong/estop"', bridge)
        self.assertIn('"/bbiyong/set_autonomy"', bridge)
        self.assertNotIn('"/bbiyong/control_mode"', command)
        self.assertNotIn('"/bbiyong/estop"', command)

        tree = ast.parse(command)
        publisher_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "create_publisher"
        ]
        self.assertEqual(publisher_calls, [])

    def test_command_uses_confirmed_bridge_service(self) -> None:
        command = (
            PACKAGE / "bbiyong_base" / "control_command.py"
        ).read_text(encoding="utf-8")
        self.assertIn("create_client", command)
        self.assertIn('"/bbiyong/set_autonomy"', command)
        self.assertIn("spin_until_future_complete", command)
        self.assertIn("response.success", command)


if __name__ == "__main__":
    unittest.main()
