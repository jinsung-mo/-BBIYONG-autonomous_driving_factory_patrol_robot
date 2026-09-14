import ast
from pathlib import Path
import unittest


PACKAGE = Path(__file__).resolve().parents[1]
ROS2_WS = PACKAGE.parents[1]


class ManualControlWiringTest(unittest.TestCase):
    def test_legacy_teleop_is_a_non_ros_retirement_shim(self) -> None:
        source = (
            ROS2_WS.parents[0]
            / "tools"
            / "diff_drive"
            / "teleop_node.py"
        ).read_text(encoding="utf-8")
        self.assertIn("has been retired", source)
        self.assertNotIn("import rclpy", source)
        self.assertNotIn("create_publisher", source)
        self.assertNotIn('"/cmd_vel"', source)
        self.assertNotIn("pgrep", source)

        relog = (
            ROS2_WS.parents[0]
            / "tools"
            / "diff_drive"
            / "base_relog.sh"
        ).read_text(encoding="utf-8")
        self.assertNotIn('nohup python3 "$HOME/calib/teleop_node.py"', relog)
        self.assertIn("resident bbiyong_manual_drive_bridge", relog)

    def test_manual_bridge_only_publishes_to_mux_input(self) -> None:
        source = (
            PACKAGE / "bbiyong_base" / "manual_drive_bridge.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        topics = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            function = node.func
            if not isinstance(function, ast.Attribute):
                continue
            if function.attr != "create_publisher" or len(node.args) < 2:
                continue
            topic = node.args[1]
            if isinstance(topic, ast.Constant):
                topics.append(topic.value)
        self.assertIn("/cmd_vel/manual", topics)
        self.assertNotIn("/cmd_vel", topics)
        self.assertIn("deadman timeout", source)
        self.assertIn("self.linear_output = 0.0", source)

    def test_control_bridge_is_the_persistent_mode_estop_authority(self) -> None:
        source = (
            PACKAGE / "bbiyong_base" / "control_state_bridge.py"
        ).read_text(encoding="utf-8")
        self.assertIn('"/bbiyong/control_mode"', source)
        self.assertIn('"/bbiyong/estop"', source)
        self.assertIn('"/bbiyong/estop_request"', source)
        self.assertIn('self.mode = "disabled"', source)
        self.assertIn("self.estop = True", source)
        self.assertIn("Never replay a release left by a previous runtime", source)

    def test_mux_clears_stale_inputs_on_handoff_and_estop(self) -> None:
        source = (
            PACKAGE / "bbiyong_base" / "cmd_mux_node.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        mode = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_mode_callback"
        )
        estop = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_estop_callback"
        )
        mode_source = ast.get_source_segment(source, mode)
        estop_source = ast.get_source_segment(source, estop)
        for callback_source in (mode_source, estop_source):
            self.assertIn("self.manual = TimedTwist()", callback_source)
            self.assertIn("self.autonomy = TimedTwist()", callback_source)
        publish = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_publish"
        )
        publish_source = ast.get_source_segment(source, publish)
        self.assertIn('self.mode == "manual"', publish_source)
        self.assertIn('self.mode == "autonomy"', publish_source)

    def test_persistent_runtime_launches_manual_and_control_bridges(self) -> None:
        source = (
            ROS2_WS
            / "src"
            / "bbiyong_bringup"
            / "launch"
            / "navigation_runtime.launch.py"
        ).read_text(encoding="utf-8")
        self.assertEqual(source.count('executable="cmd_mux"'), 1)
        self.assertEqual(source.count('executable="manual_drive_bridge"'), 1)
        self.assertEqual(source.count('executable="control_state_bridge"'), 1)


if __name__ == "__main__":
    unittest.main()
