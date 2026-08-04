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
    OverheatConfirmer,
    OVERHEAT_TEMP_C,
    FIRE_MIN_CONF,
    build_fire,
    build_overheat,
    hot_pixel_floor,
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


class ThermalSenderTest(unittest.IsolatedAsyncioTestCase):
    class Ws:
        def __init__(self):
            self.sent = []

        async def send(self, payload):
            self.sent.append(payload)

    def bridge(self, root, thermal_hz=1.0):
        values = dict(
            server_url="ws://unused", robot_id="orinka_01",
            telemetry_hz=2.0, video_hz=4.0, h264_video_hz=15.0,
            video_transport="jpeg", thermal_hz=thermal_hz,
            thermal_file=root / "ir.json",
            event_clip_enabled=False, mapping_enabled=False,
            navigation_enabled=False, manual_drive_file=root / "drive.json",
            patrol_route_file=root / "route.json",
            navigation_state_file=root / "navigation.json",
            control_state_file=root / "control.json", scouting_state_file=None,
            patrol_command=None, navigate_command=None, navigation_stop_timeout=1.0,
        )
        return Bridge(SimpleNamespace(**values))

    def _write_ir(self, path, temp_c=22.0):
        pixels = [int(round(temp_c * 10))] * (32 * 24)
        path.write_text(json.dumps({"width": 32, "height": 24, "pixels": pixels}))

    async def test_sends_one_frame_per_new_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_ir(root / "ir.json")
            ws = self.Ws()
            with patch(
                "cloud_bridge.asyncio.sleep",
                AsyncMock(side_effect=RuntimeError("stop")),
            ):
                with self.assertRaisesRegex(RuntimeError, "stop"):
                    await self.bridge(root).thermal_sender(ws)
            self.assertEqual(len(ws.sent), 1)
            frame = json.loads(ws.sent[0])
            self.assertEqual(frame["channel"], "THERMAL")

    async def test_unchanged_file_is_not_resent(self):
        # FRONT 처럼 자주 폴링해도 mtime 이 그대로면(하드웨어가 아직 새 프레임을
        # 못 만듦, -663/-664/-667) 같은 프레임을 다시 인코딩·전송하지 않는다.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_ir(root / "ir.json")
            ws = self.Ws()
            calls = {"n": 0}

            async def fake_sleep(_):
                calls["n"] += 1
                if calls["n"] >= 3:
                    raise RuntimeError("stop")

            with patch("cloud_bridge.asyncio.sleep", fake_sleep):
                with self.assertRaisesRegex(RuntimeError, "stop"):
                    await self.bridge(root).thermal_sender(ws)
            # 파일이 한 번도 안 바뀌었으니 루프를 여러 번 돌아도 딱 한 번만 보낸다
            self.assertEqual(len(ws.sent), 1)

    async def test_disabled_when_hz_is_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = self.bridge(root, thermal_hz=0.0)
            self.assertFalse(bridge.thermal_enabled)
            self.assertIsNone(bridge.thermal_period)

    async def test_missing_file_sends_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)  # ir.json 을 쓰지 않는다
            ws = self.Ws()
            with patch(
                "cloud_bridge.asyncio.sleep",
                AsyncMock(side_effect=RuntimeError("stop")),
            ):
                with self.assertRaisesRegex(RuntimeError, "stop"):
                    await self.bridge(root).thermal_sender(ws)
            self.assertEqual(ws.sent, [])

    # ── 🆕 과열 경보 통합 (thermal_sender → EVENT_OVERHEAT) ──────────────
    async def _run_frames(self, root, temps, overheat_temp_c=None):
        """온도 목록을 한 프레임씩 ir.json 에 써 가며 thermal_sender 를 돌린다."""
        ws = self.Ws()
        bridge = self.bridge(root)
        if overheat_temp_c is not None:
            bridge.overheat_temp_c = overheat_temp_c
            bridge.overheat.threshold_c = overheat_temp_c
        index = {"n": 0}

        async def fake_sleep(_):
            if index["n"] >= len(temps):
                raise RuntimeError("stop")
            self._write_ir(root / "ir.json", temp_c=temps[index["n"]])
            # mtime 이 확실히 달라지도록 손으로 밀어 준다(같은 초 안에 여러 번 쓰면
            # 파일시스템 해상도 때문에 mtime 이 안 바뀌어 프레임이 무시된다).
            stamp = time.time() + index["n"] * 0.001
            os.utime(root / "ir.json", (stamp, stamp))
            index["n"] += 1

        self._write_ir(root / "ir.json", temp_c=temps[0])
        with patch("cloud_bridge.asyncio.sleep", fake_sleep):
            with self.assertRaisesRegex(RuntimeError, "stop"):
                await bridge.thermal_sender(ws)
        return [json.loads(m) for m in ws.sent]

    async def test_overheat_event_sent_after_sustained_high_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sent = await self._run_frames(root, [120.0, 120.0, 120.0])
            events = [m for m in sent if m["type"] == "EVENT_OVERHEAT"]
            self.assertEqual(len(events), 1)          # 재경보 간격 안이라 1건
            self.assertEqual(events[0]["temperature"], 120.0)
            self.assertEqual(events[0]["threshold"], 100.0)
            # 열화상 스냅샷이 경보에 함께 실린다(RobotPacket.thermalImage)
            self.assertTrue(events[0]["thermalImage"])
            # THERMAL 영상 채널은 그대로 계속 흐른다 — 경보가 영상을 대체하지 않는다
            self.assertTrue([m for m in sent if m.get("channel") == "THERMAL"])

    async def test_no_overheat_event_below_threshold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sent = await self._run_frames(root, [99.0, 99.0, 99.0, 99.0])
            self.assertEqual([m for m in sent if m["type"] == "EVENT_OVERHEAT"], [])

    async def test_single_hot_frame_does_not_alarm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sent = await self._run_frames(root, [22.0, 150.0, 22.0, 22.0])
            self.assertEqual([m for m in sent if m["type"] == "EVENT_OVERHEAT"], [])

    async def test_overheat_disabled_when_threshold_is_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # 임계값 0 이면 confirmer 자체가 만들어지지 않는다 —
            # 오발동이 나면 재배포 없이 env 로 끌 수 있어야 한다.
            args = SimpleNamespace(
                server_url="ws://unused", robot_id="orinka_01",
                telemetry_hz=2.0, video_hz=4.0, h264_video_hz=15.0,
                video_transport="jpeg", thermal_hz=1.0,
                thermal_file=root / "ir.json", overheat_temp_c=0.0,
                event_clip_enabled=False, mapping_enabled=False,
                navigation_enabled=False, manual_drive_file=root / "drive.json",
                patrol_route_file=root / "route.json",
                navigation_state_file=root / "navigation.json",
                control_state_file=root / "control.json", scouting_state_file=None,
                patrol_command=None, navigate_command=None,
                navigation_stop_timeout=1.0,
            )
            off = Bridge(args)
            self.assertFalse(off.overheat_enabled)
            self.assertIsNone(off.overheat)


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


class FireMinConfidenceTest(unittest.TestCase):
    """🆕 신뢰도 게이트 `[사용자 지정 2026-08-04]` — 60% 미만은 경보로 안 올린다."""

    def _cam(self, conf):
        return {"t": NOW, "dets": [{"cls": 1, "conf": conf}]}

    def test_default_threshold_is_60_percent(self):
        self.assertEqual(FIRE_MIN_CONF, 0.60)

    def test_low_confidence_never_confirms(self):
        # 0.59 짜리 탐지가 계속 들어와도(N 을 다 채워도) 확정되지 않는다.
        fc = FireConfirmer(n=5, m=3)
        emits = [fc.update(self._cam(0.59), NOW + i)[0] for i in range(10)]
        self.assertEqual(emits, [False] * 10)
        self.assertFalse(fc.active)

    def test_exactly_at_threshold_counts(self):
        # 경계는 포함(>=)이다 — 0.60 은 통과한다.
        fc = FireConfirmer(n=1, m=1)
        emit, conf = fc.update(self._cam(0.60), NOW)
        self.assertTrue(emit)
        self.assertEqual(conf, 0.60)

    def test_low_confidence_frames_do_not_count_toward_m_of_n(self):
        # 🔑 핵심 회귀 방지: 게이트를 M-of-N **뒤**에 걸면 저신뢰 4프레임 +
        #    고신뢰 1프레임으로도 확정된다. 앞에 걸면 저신뢰는 아예 안 세므로
        #    고신뢰 프레임이 따로 M 번 나와야 한다.
        fc = FireConfirmer(n=5, m=3)
        for i in range(4):
            self.assertFalse(fc.update(self._cam(0.30), NOW + i)[0])
        # 이제 고신뢰가 들어와도 1/5 일 뿐 — 아직 확정 아님
        self.assertFalse(fc.update(self._cam(0.95), NOW + 4)[0])
        self.assertFalse(fc.update(self._cam(0.95), NOW + 5)[0])
        # 고신뢰 3번째에 비로소 3/5 확정
        self.assertTrue(fc.update(self._cam(0.95), NOW + 6)[0])

    def test_missing_conf_is_treated_as_zero(self):
        fc = FireConfirmer(n=1, m=1)
        emit, _ = fc.update({"t": NOW, "dets": [{"cls": 1}]}, NOW)
        self.assertFalse(emit)

    def test_reported_confidence_is_the_highest_passing_detection(self):
        fc = FireConfirmer(n=1, m=1)
        cam = {"t": NOW, "dets": [{"cls": 1, "conf": 0.65}, {"cls": 1, "conf": 0.91}]}
        emit, conf = fc.update(cam, NOW)
        self.assertTrue(emit)
        self.assertEqual(conf, 0.91)

    def test_threshold_is_configurable(self):
        fc = FireConfirmer(n=1, m=1, min_conf=0.9)
        self.assertFalse(fc.update(self._cam(0.85), NOW)[0])
        self.assertTrue(fc.update(self._cam(0.95), NOW + 1)[0])


class OverheatConfirmerTest(unittest.TestCase):
    """🆕 IR 100°C 과열 경보 `[사용자 지정 2026-08-04]`."""

    def test_default_threshold_is_100c(self):
        self.assertEqual(OVERHEAT_TEMP_C, 100.0)

    def test_below_threshold_never_emits(self):
        oc = OverheatConfirmer()
        emits = [oc.update(99.9, NOW + i)[0] for i in range(10)]
        self.assertEqual(emits, [False] * 10)

    def test_single_spike_does_not_confirm(self):
        # 768 픽셀 max() 의 단발 튐으로는 경보가 나가지 않아야 한다.
        oc = OverheatConfirmer()
        emit, _ = oc.update(150.0, NOW)
        self.assertFalse(emit)

    def test_confirms_after_m_of_n(self):
        oc = OverheatConfirmer(n=3, m=2)
        first, _ = oc.update(120.0, NOW)
        second, _ = oc.update(120.0, NOW + 1)
        self.assertEqual((first, second), (False, True))

    def test_exactly_at_threshold_counts(self):
        oc = OverheatConfirmer(n=1, m=1)
        self.assertTrue(oc.update(100.0, NOW)[0])

    def test_missing_frame_counts_as_below(self):
        # 센서가 죽어 프레임이 없을 때 마지막 뜨거운 값으로 경보를 유지하지 않는다.
        oc = OverheatConfirmer(n=3, m=2)
        oc.update(120.0, NOW)
        self.assertFalse(oc.update(None, NOW + 1)[0])
        self.assertFalse(oc.update(None, NOW + 2)[0])
        self.assertFalse(oc.active)

    def test_reemit_only_after_interval(self):
        oc = OverheatConfirmer(n=1, m=1, reemit_sec=10.0)
        first, _ = oc.update(120.0, NOW)
        soon, _ = oc.update(120.0, NOW + 1)
        later, _ = oc.update(120.0, NOW + 11)
        self.assertEqual((first, soon, later), (True, False, True))


class HotPixelFloorTest(unittest.TestCase):
    """🆕 고착 불량 픽셀 방어 `[agy 외부검토 2026-08-04]` — 시간 디바운스(M-of-N)는
    매 프레임 똑같이 뜨거운 고착 픽셀을 못 막는다. 공간 조건이 따로 필요하다."""

    def _grid(self, hot_temps, base_c=22.0, total=32 * 24):
        pixels = [int(round(base_c * 10))] * total
        for i, t in enumerate(hot_temps):
            pixels[i] = int(round(t * 10))
        return {"width": 32, "height": 24, "pixels": pixels}

    def test_single_hot_pixel_does_not_reach_threshold(self):
        # 딱 한 픽셀만 500도 — floor(2번째로 뜨거운 값)는 실온이라 경보 안 됨
        floor = hot_pixel_floor(self._grid([500.0]))
        self.assertAlmostEqual(floor, 22.0)
        self.assertLess(floor, OVERHEAT_TEMP_C)

    def test_two_hot_pixels_reach_threshold(self):
        floor = hot_pixel_floor(self._grid([500.0, 120.0]))
        self.assertAlmostEqual(floor, 120.0)
        self.assertGreaterEqual(floor, OVERHEAT_TEMP_C)

    def test_returns_none_without_pixels(self):
        self.assertIsNone(hot_pixel_floor({"pixels": []}))
        self.assertIsNone(hot_pixel_floor(None))

    def test_configurable_minimum(self):
        grid = self._grid([500.0, 400.0, 300.0])
        self.assertAlmostEqual(hot_pixel_floor(grid, min_hot_pixels=3), 300.0)


class OverheatPacketTest(unittest.TestCase):
    def test_uses_flat_be_system_contract(self):
        # 🔴 BE_system RobotPacket.java 는 평탄한 temperature/threshold 를 읽는다.
        #    초안(§5.3)의 중첩 thermal{} 로 보내면 ignoreUnknown 때문에 조용히
        #    null 로 수신된다 — 이 테스트가 그 회귀를 막는다.
        packet = build_overheat("r1", 123.456, None, NOW)
        self.assertEqual(packet["type"], "EVENT_OVERHEAT")
        self.assertEqual(packet["temperature"], 123.5)
        self.assertEqual(packet["threshold"], 100.0)
        self.assertNotIn("thermal", packet)

    def test_equipment_id_is_null_for_server_to_resolve(self):
        # 로봇은 설비 목록을 갖고 있지 않다. 서버가 location 으로 판정한다(§5.3).
        packet = build_overheat("r1", 120.0, None, NOW)
        self.assertIsNone(packet["equipment_id"])

    def test_includes_pose_when_fresh(self):
        nav = {"t": NOW, "pose": {"frame": "map", "x": 3.0, "y": 4.0, "yaw": 1.0}}
        packet = build_overheat("r1", 120.0, nav, NOW)
        self.assertEqual(packet["location"], {"x": 3.0, "y": 4.0, "yaw": 1.0})

    def test_omits_pose_when_stale(self):
        nav = {"t": NOW - 999, "pose": {"frame": "map", "x": 3.0, "y": 4.0}}
        self.assertNotIn("location", build_overheat("r1", 120.0, nav, NOW))

    def test_thermal_image_attached_when_supplied(self):
        packet = build_overheat("r1", 120.0, None, NOW, thermal_image="QUJD")
        self.assertEqual(packet["thermalImage"], "QUJD")

    def test_thermal_image_omitted_when_absent(self):
        self.assertNotIn("thermalImage", build_overheat("r1", 120.0, None, NOW))


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
