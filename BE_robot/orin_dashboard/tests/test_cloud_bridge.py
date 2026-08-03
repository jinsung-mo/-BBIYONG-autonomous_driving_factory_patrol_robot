import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from cloud_bridge import (
    Bridge,
    FireConfirmer,
    build_fire,
    build_register,
    build_telemetry,
    build_video,
    fresh,
    infer_status,
    select_mission_status,
    translate_command,
)

NOW = 1000.0


class FreshnessTest(unittest.TestCase):
    def test_fresh_within_window(self):
        self.assertTrue(fresh({"t": NOW - 1.0}, NOW))

    def test_stale_beyond_window(self):
        self.assertFalse(fresh({"t": NOW - 60.0}, NOW))

    def test_missing_timestamp_is_stale(self):
        self.assertFalse(fresh({}, NOW))
        self.assertFalse(fresh(None, NOW))


class StatusTest(unittest.TestCase):
    def test_mapping_status_has_navigation_precedence(self):
        self.assertEqual(select_mission_status("MAPPING", "AUTO_PATROL"), "MAPPING")
        self.assertEqual(select_mission_status(None, "AUTO_PATROL"), "AUTO_PATROL")
    def test_patrol_running_is_auto_patrol(self):
        self.assertEqual(
            infer_status({"patrol_running": True, "v": 0.0, "w": 0.0}, NOW),
            "AUTO_PATROL",
        )

    def test_moving_is_manual_control(self):
        self.assertEqual(
            infer_status({"patrol_running": False, "v": 0.1, "w": 0.0}, NOW),
            "MANUAL_CONTROL",
        )

    def test_idle_is_unknown(self):
        self.assertIsNone(
            infer_status({"patrol_running": False, "v": 0.0, "w": 0.0}, NOW)
        )


class TelemetryTest(unittest.TestCase):
    def test_includes_pose_when_fresh_and_mapped(self):
        nav = {"t": NOW, "pose": {"frame": "map", "x": 1.0, "y": 2.0, "yaw": 0.5}}
        packet = build_telemetry("r1", nav, None, None, NOW)
        self.assertEqual(packet["location"], {"x": 1.0, "y": 2.0, "yaw": 0.5})

    def test_omits_pose_when_stale(self):
        nav = {"t": NOW - 60, "pose": {"frame": "map", "x": 1.0, "y": 2.0, "yaw": 0.0}}
        packet = build_telemetry("r1", nav, None, None, NOW)
        self.assertNotIn("location", packet)

    def test_omits_pose_without_frame(self):
        # frame 이 없으면(=TF 미확보) 위치를 신뢰할 수 없다 → 생략
        nav = {"t": NOW, "pose": {"frame": None, "x": 1.0, "y": 2.0, "yaw": 0.0}}
        packet = build_telemetry("r1", nav, None, None, NOW)
        self.assertNotIn("location", packet)

    def test_speed_and_inference_fps(self):
        drive = {"t": NOW, "v": 0.12, "w": 0.0, "patrol_running": False}
        cam = {"t": NOW, "det_fps": 9.5}
        packet = build_telemetry("r1", None, drive, cam, NOW)
        self.assertEqual(packet["speed"], 0.12)
        self.assertEqual(packet["inferenceFps"], 9.5)

    def test_latency_and_estop(self):
        packet = build_telemetry("r1", None, None, None, NOW,
                                 latency_ms=42.7, estop="ENGAGED")
        self.assertEqual(packet["commLatencyMs"], 42)
        self.assertEqual(packet["estop"], "ENGAGED")


class VideoTest(unittest.TestCase):
    def test_front_frame(self):
        frame = build_video("r1", {"jpeg": "AAAA"}, 7)
        self.assertEqual(frame["channel"], "FRONT")
        self.assertEqual(frame["format"], "jpeg")
        self.assertEqual(frame["data"], "AAAA")
        self.assertEqual(frame["seq"], 7)

    def test_none_without_jpeg(self):
        self.assertIsNone(build_video("r1", {}, 1))
        self.assertIsNone(build_video("r1", None, 1))


class FireConfirmerTest(unittest.TestCase):
    def _cam(self, fire=False, conf=0.9):
        dets = [{"cls": 1, "conf": conf}] if fire else []
        return {"t": NOW, "dets": dets}

    def test_confirms_after_m_of_n(self):
        fc = FireConfirmer(n=5, m=3)
        emits = []
        for i in range(4):  # 화재 아님 2 → 화재 3
            fire = i >= 1
            emit, conf = fc.update(self._cam(fire=fire), NOW + i)
            emits.append(emit)
        # 3번째 화재 프레임에서 3/5 확정 → 상승엣지 emit
        self.assertEqual(emits, [False, False, False, True])

    def test_single_spike_does_not_confirm(self):
        fc = FireConfirmer(n=5, m=3)
        emit, _ = fc.update(self._cam(fire=True), NOW)
        self.assertFalse(emit)

    def test_reemit_only_after_interval(self):
        fc = FireConfirmer(n=1, m=1, reemit_sec=10.0)
        first, _ = fc.update(self._cam(fire=True), NOW)
        soon, _ = fc.update(self._cam(fire=True), NOW + 1)   # 간격 미달
        later, _ = fc.update(self._cam(fire=True), NOW + 11)  # 간격 초과
        self.assertEqual((first, soon, later), (True, False, True))


class FirePacketTest(unittest.TestCase):
    def test_includes_confidence_and_pose(self):
        nav = {"t": NOW, "pose": {"frame": "map", "x": 3.0, "y": 4.0, "yaw": 1.0}}
        packet = build_fire("r1", 0.876543, nav, NOW)
        self.assertEqual(packet["type"], "EVENT_FIRE")
        self.assertEqual(packet["confidence"], 0.877)
        self.assertEqual(packet["location"]["x"], 3.0)


class CommandTest(unittest.TestCase):
    def test_drive(self):
        action, payload, estop = translate_command(
            {"command": "DRIVE", "linear": 0.1, "angular": -0.2}, NOW)
        self.assertEqual(action, "drive")
        self.assertEqual(payload, {"armed": True, "v": 0.1, "w": -0.2, "ts": NOW})
        self.assertEqual(estop, "RELEASED")

    def test_estop_stops_and_disarms(self):
        action, payload, estop = translate_command(
            {"command": "ESTOP", "active": True}, NOW)
        self.assertEqual(action, "drive")
        self.assertEqual(payload, {"armed": False, "v": 0.0, "w": 0.0, "ts": NOW})
        self.assertEqual(estop, "ENGAGED")

    def test_navigation_commands_are_dispatched(self):
        for command in ("SET_PATROL_ROUTE", "SET_MODE", "NAVIGATE"):
            action, payload = translate_command({"command": command}, NOW)
            self.assertEqual(action, "navigation", command)
            self.assertEqual(payload["command"], command)

    def test_mapping_commands_are_dispatched(self):
        for command in ("START_MAPPING", "STOP_MAPPING", "SAVE_MAP"):
            action, payload = translate_command(
                {"command": command, "name": "factory_01"}, NOW
            )
            self.assertEqual(action, "mapping", command)
            self.assertEqual(payload["command"], command)

    def test_unknown_is_bad(self):
        action, reason = translate_command({"command": "FLY"}, NOW)
        self.assertEqual(action, "bad")

    def test_register_shape(self):
        self.assertEqual(
            build_register("orinka_01"),
            {"source": "robot", "type": "REGISTER", "robot_id": "orinka_01"},
        )


class BridgeControlTest(unittest.IsolatedAsyncioTestCase):
    async def test_backend_estop_always_latches_persistent_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(
                server_url="ws://unused",
                robot_id="orinka_01",
                telemetry_hz=2.0,
                video_hz=4.0,
                mapping_enabled=False,
                navigation_enabled=False,
                patrol_route_file=root / "route.json",
                navigation_state_file=root / "navigation.json",
                control_state_file=root / "control.json",
                scouting_state_file=None,
                patrol_command=None,
                navigate_command=None,
                navigation_stop_timeout=1.0,
            )
            bridge = Bridge(args)

            class Incoming:
                def __aiter__(self):
                    async def messages():
                        yield json.dumps({"command": "ESTOP", "active": True})
                    return messages()

            drive_file = root / "drive.json"
            with patch("cloud_bridge.DRIVE_FILE", str(drive_file)):
                await bridge.receiver(Incoming())

            self.assertFalse(json.loads(drive_file.read_text())["armed"])
            control = json.loads((root / "control.json").read_text())
            self.assertEqual(control["mode"], "disabled")
            self.assertTrue(control["estop"])


if __name__ == "__main__":
    unittest.main()
