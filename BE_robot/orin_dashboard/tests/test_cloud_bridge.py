import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from cloud_bridge import (
    Bridge,
    FireConfirmer,
    build_fire,
    build_register,
    build_telemetry,
    build_video,
    fresh,
    infer_status,
    parse_args,
    select_mission_status,
    translate_command,
    websocket_auth_kwargs,
)
from h264_protocol import H264Packet, encode_packet

NOW = 1000.0


class WebSocketAuthTest(unittest.TestCase):
    def test_modern_websockets_uses_additional_headers(self):
        def connect(uri, *, additional_headers=None):
            return None

        with patch.dict(os.environ, {"ORINCAR_ROBOT_TOKEN": "robot-secret"}, clear=True):
            kwargs = websocket_auth_kwargs(connect)
        self.assertEqual(
            kwargs, {"additional_headers": {"X-Robot-Token": "robot-secret"}}
        )

    def test_legacy_websockets_uses_extra_headers_and_upload_token(self):
        def connect(uri, *, extra_headers=None):
            return None

        with patch.dict(
            os.environ, {"BBIYONG_ROBOT_UPLOAD_TOKEN": "shared-secret"}, clear=True
        ):
            kwargs = websocket_auth_kwargs(connect)
        self.assertEqual(
            kwargs, {"extra_headers": {"X-Robot-Token": "shared-secret"}}
        )

    def test_missing_token_keeps_development_connection_compatible(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(websocket_auth_kwargs(lambda: None), {})


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


class BinaryVideoTest(unittest.IsolatedAsyncioTestCase):
    class Ws:
        def __init__(self):
            self.sent = []

        async def send(self, payload):
            self.sent.append(payload)
            raise RuntimeError("stop after first send")

    def packet(self, keyframe=True):
        return encode_packet(H264Packet(
            robot_id="orinka_01",
            stream_id=5,
            sequence=1,
            timestamp_ms=int(time.time() * 1000),
            width=640,
            height=480,
            fps=15,
            keyframe=keyframe,
            codec_config=keyframe,
            payload=b"\x00\x00\x00\x01\x65",
        ))

    def bridge(self, root):
        values = dict(
            server_url="ws://unused", robot_id="orinka_01",
            telemetry_hz=2.0, video_hz=4.0, h264_video_hz=15.0,
            video_transport="h264", h264_frame_file=root / "frame.bin",
            event_clip_enabled=False, mapping_enabled=False,
            navigation_enabled=False, manual_drive_file=root / "drive.json",
            patrol_route_file=root / "route.json",
            navigation_state_file=root / "navigation.json",
            control_state_file=root / "control.json", scouting_state_file=None,
            patrol_command=None, navigate_command=None, navigation_stop_timeout=1.0,
        )
        return Bridge(SimpleNamespace(**values))

    async def test_binary_sender_forwards_valid_keyframe_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.packet(keyframe=True)
            (root / "frame.bin").write_bytes(payload)
            ws = self.Ws()
            with self.assertRaisesRegex(RuntimeError, "stop after first"):
                await self.bridge(root).h264_video_sender(ws)
            self.assertEqual(ws.sent, [payload])

    async def test_binary_sender_waits_for_keyframe_after_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "frame.bin").write_bytes(self.packet(keyframe=False))
            ws = self.Ws()
            with patch("cloud_bridge.asyncio.sleep", AsyncMock(side_effect=RuntimeError("stop"))):
                with self.assertRaisesRegex(RuntimeError, "stop"):
                    await self.bridge(root).h264_video_sender(ws)
            self.assertEqual(ws.sent, [])


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

    def test_event_saved_is_dispatched(self):
        action, payload = translate_command(
            {"command": "EVENT_SAVED", "eventId": 42, "type": "FIRE"}, NOW
        )
        self.assertEqual(action, "event_saved")
        self.assertEqual(payload["eventId"], 42)

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
    def make_bridge(self, root, **capabilities):
        values = dict(
            server_url="ws://unused",
            robot_id="orinka_01",
            telemetry_hz=2.0,
            video_hz=4.0,
            mapping_enabled=False,
            navigation_enabled=False,
            patrol_route_file=root / "route.json",
            navigation_state_file=root / "navigation.json",
            control_state_file=root / "control.json",
            manual_drive_file=root / "drive.json",
            scouting_state_file=None,
            patrol_command=None,
            navigate_command=None,
            navigation_stop_timeout=1.0,
            event_clip_state_file=root / "event_clips.json",
            blackbox_manifest_file=root / "manifest.json",
            video_upload_url="http://unused/api/videos/upload",
        )
        values.update(capabilities)
        return Bridge(SimpleNamespace(**values))

    class Incoming:
        def __init__(self, *commands):
            self.commands = commands

        def __aiter__(self):
            async def messages():
                for command in self.commands:
                    yield json.dumps(command)
            return messages()

    async def test_backend_estop_always_latches_persistent_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = self.make_bridge(root)

            drive_file = root / "drive.json"
            await bridge.receiver(self.Incoming(
                {"command": "ESTOP", "active": True}
            ))

            self.assertFalse(json.loads(drive_file.read_text())["armed"])
            control = json.loads((root / "control.json").read_text())
            self.assertEqual(control["mode"], "disabled")
            self.assertTrue(control["estop"])

    async def test_drive_requires_backend_control_capability(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            drive_file = root / "drive.json"
            disabled = self.make_bridge(root)
            await disabled.receiver(self.Incoming(
                {"command": "DRIVE", "linear": 0.2, "angular": 0.0}
            ))
            self.assertFalse(json.loads(drive_file.read_text())["armed"])

            enabled = self.make_bridge(root, backend_control_enabled=True)
            await enabled.receiver(self.Incoming(
                {"command": "DRIVE", "linear": 0.2, "angular": 0.0}
            ))
            self.assertTrue(json.loads(drive_file.read_text())["armed"])

    async def test_navigation_capabilities_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.make_bridge(
                Path(directory),
                backend_control_enabled=True,
                one_off_navigation_enabled=False,
                patrol_enabled=False,
            )
            bridge.navigation.handle_command = AsyncMock(return_value=(True, "ok"))
            await bridge.receiver(self.Incoming(
                {"command": "SET_MODE", "mode": "manual"},
                {"command": "SET_MODE", "mode": "disabled"},
                {"command": "SET_MODE", "mode": "autonomy"},
                {"command": "SET_PATROL_ROUTE", "waypoints": []},
                {"command": "NAVIGATE", "x": 0, "y": 0},
            ))
            self.assertEqual(bridge.navigation.handle_command.await_count, 2)
            self.assertEqual(
                bridge.navigation.handle_command.await_args_list[0].args[0],
                {"command": "SET_MODE", "mode": "manual"},
            )
            self.assertEqual(
                bridge.navigation.handle_command.await_args_list[1].args[0],
                {"command": "SET_MODE", "mode": "disabled"},
            )

    async def test_event_saved_is_durably_queued_without_blocking_receiver(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = self.make_bridge(root)
            await bridge.receiver(self.Incoming(
                {"command": "EVENT_SAVED", "eventId": 42, "type": "FIRE"}
            ))
            state = json.loads((root / "event_clips.json").read_text())
            self.assertEqual(state["jobs"]["42"]["status"], "pending")
            self.assertEqual(state["jobs"]["42"]["eventType"], "FIRE")


class CapabilityArgumentTest(unittest.TestCase):
    def test_legacy_cli_switch_enables_all_capabilities(self):
        with patch.dict("os.environ", {}, clear=True):
            args = parse_args(["--navigation-enabled"])
        self.assertTrue(args.backend_control_enabled)
        self.assertTrue(args.one_off_navigation_enabled)
        self.assertTrue(args.patrol_enabled)
        self.assertTrue(args.patrol_loop_enabled)

    def test_environment_capabilities_are_independent(self):
        environment = {
            "ORINCAR_BACKEND_CONTROL_ENABLED": "1",
            "ORINCAR_ONE_OFF_NAVIGATION_ENABLED": "0",
            "ORINCAR_PATROL_ENABLED": "1",
            "ORINCAR_PATROL_LOOP_ENABLED": "0",
        }
        with patch.dict("os.environ", environment, clear=True):
            args = parse_args([])
        self.assertTrue(args.backend_control_enabled)
        self.assertFalse(args.one_off_navigation_enabled)
        self.assertTrue(args.patrol_enabled)
        self.assertFalse(args.patrol_loop_enabled)


if __name__ == "__main__":
    unittest.main()
