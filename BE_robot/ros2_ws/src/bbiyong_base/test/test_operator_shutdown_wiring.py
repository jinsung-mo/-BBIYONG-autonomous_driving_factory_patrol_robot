import unittest
from pathlib import Path


class OperatorShutdownWiringTest(unittest.TestCase):
    def test_symlink_target_is_resolved_before_workspace_lookup(self) -> None:
        root = Path(__file__).parents[3]
        script = (root / "scripts" / "bbiyong").read_text()
        self.assertIn('SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"', script)
        self.assertIn('dirname "$SCRIPT_PATH"', script)

    def test_all_control_nodes_use_context_safe_shutdown(self) -> None:
        package = Path(__file__).parents[1] / "bbiyong_base"
        for node_name in (
            "cmd_mux_node.py",
            "ackermann_adapter_node.py",
            "differential_adapter_node.py",
        ):
            source = (package / node_name).read_text()
            with self.subTest(node_name=node_name):
                self.assertIn("rclpy.ok(context=", source)
                self.assertIn("rclpy.try_shutdown()", source)
        for node_name in (
            "cmd_mux_node.py",
            "ackermann_adapter_node.py",
            "differential_adapter_node.py",
        ):
            source = (package / node_name).read_text()
            with self.subTest(node_name=f"{node_name}-interrupt"):
                self.assertIn("except KeyboardInterrupt:", source)
                self.assertIn("node.destroy_node()", source)

    def test_operator_sources_workspaces_with_nounset_temporarily_disabled(self) -> None:
        root = Path(__file__).parents[3]
        script = (root / "scripts" / "bbiyong").read_text()
        self.assertIn("set +u", script)
        self.assertIn("source /opt/ros/humble/setup.bash", script)
        self.assertIn("set -u", script)


if __name__ == "__main__":
    unittest.main()
