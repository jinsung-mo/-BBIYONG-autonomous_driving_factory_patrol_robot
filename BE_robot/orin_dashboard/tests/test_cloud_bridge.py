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
    build_thermal,
    build_video,
    fresh,
    infer_status,
    parse_args,
    select_mission_status,
    translate_command,
    websocket_auth_kwargs,
    _rotate_cw90,
    _rotate_cw180,
)
from h264_protocol import H264Packet, encode_packet
import base64
import struct
import zlib

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

    def test_battery_included_when_env_fresh_and_connected(self):
        env = {"ts": NOW, "battery": {"connected": True, "volts": 22.1, "percent": 63.0}}
        packet = build_telemetry("r1", None, None, None, NOW, env=env)
        self.assertEqual(packet["battery"], 63.0)

    def test_battery_omitted_when_env_stale(self):
        env = {"ts": NOW - 60, "battery": {"connected": True, "percent": 63.0}}
        packet = build_telemetry("r1", None, None, None, NOW, env=env)
        self.assertNotIn("battery", packet)

    def test_battery_omitted_when_ina226_not_connected(self):
        env = {"ts": NOW, "battery": {"connected": False, "volts": None, "percent": None}}
        packet = build_telemetry("r1", None, None, None, NOW, env=env)
        self.assertNotIn("battery", packet)

    def test_battery_omitted_when_env_missing(self):
        packet = build_telemetry("r1", None, None, None, NOW, env=None)
        self.assertNotIn("battery", packet)


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


def _decode_png_dims(png_b64):
    """테스트 전용 최소 PNG 파서 — IHDR 의 width/height 만 읽는다."""
    raw = base64.b64decode(png_b64)
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    length = struct.unpack(">I", raw[8:12])[0]
    assert raw[12:16] == b"IHDR"
    width, height = struct.unpack(">II", raw[16:24])
    assert length == 13
    return raw, width, height


class ThermalTest(unittest.TestCase):
    """S15P11E101 열화상 관제 미표시 수정 — build_thermal() 이 build_video() 의
    FRONT 채널과 나란히 THERMAL 채널을 만든다. 로봇이 이제 MLX90640 을 생산한다
    (server.py /api/thermal 로 실측 확인됨, cloud_bridge.py 의 오래된 docstring이
    "로봇이 아직 생산하지 않는다"고 적어둔 건 그 시점 이후로 낡은 것이었다)."""

    def _pixels(self, temp_c, width=32, height=24):
        # 펌웨어 계약: 온도(°C)*10 의 int
        return [int(round(temp_c * 10))] * (width * height)

    def test_thermal_frame_shape(self):
        thermal = {"width": 32, "height": 24, "pixels": self._pixels(23.4)}
        frame = build_thermal("r1", thermal, 3)
        self.assertEqual(frame["type"], "VIDEO_FRAME")
        self.assertEqual(frame["channel"], "THERMAL")
        self.assertEqual(frame["format"], "png")
        self.assertEqual(frame["seq"], 3)
        self.assertEqual(frame["maxTemp"], 23.4)
        self.assertIn("data", frame)

    def test_thermal_frame_is_valid_png_with_correct_dims(self):
        # 180도 회전은 치수를 바꾸지 않는다(90도 회전 두 번 = 원래 비율로 복귀).
        thermal = {"width": 32, "height": 24, "pixels": self._pixels(30.0)}
        frame = build_thermal("r1", thermal, 1)
        raw, width, height = _decode_png_dims(frame["data"])
        self.assertEqual((width, height), (32, 24))
        # IDAT 이 실제로 zlib 로 풀리고, 필터바이트 포함 스트라이드와 맞아야 한다
        idat_start = raw.index(b"IDAT") + 4
        idat_len = struct.unpack(">I", raw[idat_start - 8:idat_start - 4])[0]
        idat = raw[idat_start:idat_start + idat_len]
        decompressed = zlib.decompress(idat)
        self.assertEqual(len(decompressed), (32 * 3 + 1) * 24)

    def test_max_temp_reflects_hottest_pixel(self):
        pixels = self._pixels(20.0)
        pixels[100] = 481  # 48.1°C — 하나만 뜨겁게
        frame = build_thermal("r1", {"width": 32, "height": 24, "pixels": pixels}, 1)
        self.assertEqual(frame["maxTemp"], 48.1)

    def test_none_without_pixels(self):
        self.assertIsNone(build_thermal("r1", {"width": 32, "height": 24, "pixels": []}, 1))
        self.assertIsNone(build_thermal("r1", {}, 1))
        self.assertIsNone(build_thermal("r1", None, 1))

    def test_none_on_dimension_mismatch(self):
        # width*height 와 pixels 길이가 안 맞으면(깨진 프레임) 그리지 않는다
        thermal = {"width": 32, "height": 24, "pixels": [200] * 10}
        self.assertIsNone(build_thermal("r1", thermal, 1))


class ThermalRotationTest(unittest.TestCase):
    """2026-08-04 방향 수정 — 사용자가 화면에서 육안으로 재확인하며 3차례
    조정했다: ①좌우반전(폐기) → ②시계방향 90도(폐기) → ③시계방향 180도(현재).
    매번 직전 시도를 **대체**했다(누적 합성 아님). 실측이 아니라 사용자 육안
    판단 기준이므로, "지금 코드가 실제로 시계방향 180도를 돌린다"는 것 자체를
    테스트로 고정해 다음 조정의 회귀 기준으로 삼는다. _rotate_cw90 자체의
    동작(90도 하나만)도 _rotate_cw180 이 그 위에 합성되므로 별도로 계속 검증한다."""

    def test_rotate_cw90_swaps_dims_and_orientation(self):
        # 2행 3열(width=3,height=2) → 3행 2열(width=2,height=3).
        # 원본:
        #   1 2 3
        #   4 5 6
        # 시계방향 90도:
        #   4 1
        #   5 2
        #   6 3
        grid = [1, 2, 3,
                4, 5, 6]
        rotated, new_w, new_h = _rotate_cw90(grid, width=3, height=2)
        self.assertEqual((new_w, new_h), (2, 3))
        self.assertEqual(rotated, [4, 1, 5, 2, 6, 3])

    def test_rotate_cw180_preserves_dims_and_reverses_order(self):
        # 180도 회전은 전체 배열을 뒤집는 것과 수학적으로 동치다(90도 두 번 적용한
        # 결과가 실제로 그렇게 나오는지는 손으로 검증해 확인했다 — 코드가 그
        # 성질을 실제로 만족하는지 여기서 잠근다).
        # 원본:            180도:
        #   1 2 3            6 5 4
        #   4 5 6            3 2 1
        grid = [1, 2, 3,
                4, 5, 6]
        rotated, new_w, new_h = _rotate_cw180(grid, width=3, height=2)
        self.assertEqual((new_w, new_h), (3, 2))  # 치수는 유지된다
        self.assertEqual(rotated, [6, 5, 4, 3, 2, 1])

    def test_build_thermal_output_is_rotated_180_end_to_end(self):
        # 원본 (row0, col0) 만 뜨겁게 만든다. 180도 회전은 치수를 바꾸지 않고
        # (8x4 그대로) 전체 반전과 동치이므로, 뜨거운 값은 결과의
        # **마지막 행·마지막 열**에 와야 한다.
        width, height = 8, 4
        pixels = [200] * (width * height)  # 20.0°C 배경
        pixels[0] = 500                      # (row0, col0) 만 50.0°C
        frame = build_thermal("r1", {"width": width, "height": height, "pixels": pixels}, 1)
        raw = base64.b64decode(frame["data"])
        assert raw[:8] == b"\x89PNG\r\n\x1a\n"
        new_w, new_h = struct.unpack(">II", raw[16:24])
        self.assertEqual((new_w, new_h), (width, height))  # 180도는 치수를 안 바꾼다
        idat_start = raw.index(b"IDAT") + 4
        idat_len = struct.unpack(">I", raw[idat_start - 8:idat_start - 4])[0]
        decompressed = zlib.decompress(raw[idat_start:idat_start + idat_len])
        stride = new_w * 3 + 1  # 필터 바이트 1 + RGB
        # 결과의 첫 픽셀(첫 행 첫 열)은 배경(20°C)이어야 한다.
        self.assertEqual(decompressed[0], 0)  # 필터 타입 None
        self.assertEqual(decompressed[1], 30, "결과 첫 픽셀은 배경이어야 한다")
        # 원본 (row0,col0) 의 뜨거운 값은 마지막 행의 마지막 열에 와야 한다.
        last_row_start = (height - 1) * stride
        last_row = decompressed[last_row_start:last_row_start + stride]
        self.assertEqual(last_row[0], 0)  # 필터 타입 None
        last_pixel_r = last_row[1 + (width - 1) * 3]
        self.assertEqual(last_pixel_r, 255,
                          "180도 회전 후 원본 (row0,col0) 은 마지막 행의 마지막 열에 와야 한다")


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
