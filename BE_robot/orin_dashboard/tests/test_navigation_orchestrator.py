import json
from pathlib import Path
import sys
import tempfile
import unittest

from navigation_orchestrator import (
    NavigationOrchestrator,
    NavigationState,
    validate_route,
)


HELPER = Path(__file__).with_name("fake_mapping_process.py")


def fake_command(mode, placeholders):
    return (
        f'"{Path(sys.executable).as_posix()}" "{HELPER.as_posix()}" '
        f"{mode} {placeholders}"
    )


class RouteValidationTest(unittest.TestCase):
    def test_sorts_and_normalizes_backend_route(self):
        route = validate_route([
            {"seq": 2, "x": 2, "y": 3, "yaw": None, "name": "b"},
            {"seq": 1, "x": 0.5, "y": -1, "yaw": 0.2, "name": "a"},
        ])
        self.assertEqual([point["seq"] for point in route], [1, 2])
        self.assertEqual(route[1]["yaw"], 0.0)

    def test_rejects_empty_duplicate_and_non_finite_routes(self):
        with self.assertRaises(ValueError):
            validate_route([])
        with self.assertRaises(ValueError):
            validate_route([
                {"seq": 1, "x": 0, "y": 0},
                {"seq": 1, "x": 1, "y": 1},
            ])
        with self.assertRaises(ValueError):
            validate_route([{"seq": 0, "x": float("nan"), "y": 0}])


class NavigationOrchestratorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def make(self, patrol=None, navigate=None):
        return NavigationOrchestrator(
            robot_id="orinka_01",
            route_file=self.root / "route.json",
            state_file=self.root / "state.json",
            control_file=self.root / "control.json",
            patrol_command=patrol,
            navigate_command=navigate,
            process_stop_timeout=1.0,
        )

    def control(self):
        return json.loads((self.root / "control.json").read_text())

    async def test_restart_is_disabled_and_estopped(self):
        orchestrator = self.make()
        self.assertEqual(orchestrator.state, NavigationState.DISABLED)
        self.assertEqual(self.control()["mode"], "disabled")
        self.assertTrue(self.control()["estop"])

    async def test_route_is_validated_and_persisted(self):
        orchestrator = self.make()
        accepted, _ = await orchestrator.set_route([
            {"seq": 1, "x": 2, "y": 3},
            {"seq": 0, "x": 0, "y": 1, "yaw": 0.5},
        ])
        self.assertTrue(accepted)
        saved = json.loads((self.root / "route.json").read_text())
        self.assertEqual(saved["robotId"], "orinka_01")
        self.assertEqual([item["seq"] for item in saved["waypoints"]], [0, 1])

    async def test_manual_mode_cancels_navigation_and_selects_manual(self):
        orchestrator = self.make()
        accepted, _ = await orchestrator.set_mode("manual")
        self.assertTrue(accepted)
        self.assertEqual(orchestrator.state, NavigationState.MANUAL)
        self.assertEqual(self.control()["mode"], "manual")
        self.assertFalse(self.control()["estop"])

    async def test_autonomy_requires_route_and_command(self):
        orchestrator = self.make()
        accepted, reason = await orchestrator.set_mode("autonomy")
        self.assertFalse(accepted)
        self.assertIn("route", reason)
        await orchestrator.set_route([{"seq": 0, "x": 0, "y": 0}])
        accepted, reason = await orchestrator.set_mode("autonomy")
        self.assertFalse(accepted)
        self.assertIn("not configured", reason)

    async def test_patrol_and_estop_have_deterministic_ownership(self):
        orchestrator = self.make(
            patrol=fake_command("sleep", "{route_file}")
        )
        await orchestrator.set_route([{"seq": 0, "x": 0, "y": 0}])
        accepted, _ = await orchestrator.set_mode("autonomy")
        self.assertTrue(accepted)
        process = orchestrator._process
        self.assertEqual(orchestrator.state, NavigationState.PATROLLING)
        self.assertEqual(orchestrator.telemetry_status, "AUTO_PATROL")
        self.assertEqual(self.control()["mode"], "autonomy")

        accepted, _ = await orchestrator.emergency_stop()
        self.assertTrue(accepted)
        self.assertIsNotNone(process.returncode)
        self.assertEqual(orchestrator.state, NavigationState.ESTOPPED)
        self.assertTrue(self.control()["estop"])

    async def test_route_replacement_does_not_interrupt_active_patrol(self):
        orchestrator = self.make(patrol=fake_command("sleep", "{route_file}"))
        await orchestrator.set_route([{"seq": 0, "x": 0, "y": 0}])
        accepted, _ = await orchestrator.set_mode("autonomy")
        self.assertTrue(accepted)
        process = orchestrator._process

        accepted, reason = await orchestrator.set_route([
            {"seq": 0, "x": 4, "y": 2, "yaw": 0.25}
        ])
        self.assertTrue(accepted)
        self.assertIn("unchanged", reason)
        self.assertIs(orchestrator._process, process)
        self.assertIsNone(process.returncode)
        await orchestrator.emergency_stop()

    async def test_navigate_validates_goal_and_starts_configured_client(self):
        orchestrator = self.make(
            navigate=fake_command("sleep", "{x}")
        )
        accepted, reason = await orchestrator.navigate(None, 1, 0)
        self.assertFalse(accepted)
        self.assertIn("x", reason)
        accepted, _ = await orchestrator.navigate(1, 2, None)
        self.assertTrue(accepted)
        self.assertEqual(orchestrator.state, NavigationState.NAVIGATING)
        await orchestrator.emergency_stop()
