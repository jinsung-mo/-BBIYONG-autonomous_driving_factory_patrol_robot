import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

from mapping_orchestrator import (
    MappingOrchestrator,
    MappingState,
    encode_multipart,
    parse_map_yaml,
    rewrite_map_yaml_image,
    safe_map_name,
)


HELPER = Path(__file__).with_name("fake_mapping_process.py")


def command(mode):
    return f'"{Path(sys.executable).as_posix()}" "{HELPER.as_posix()}" {mode} {{map_output}}'


def wait_for_state(orchestrator, state, timeout=3.0):
    async def wait():
        deadline = time.monotonic() + timeout
        while orchestrator.state != state:
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"timed out waiting for {state}; current={orchestrator.state}"
                )
            await asyncio.sleep(0.01)
    return wait()


class ArtifactTest(unittest.TestCase):
    def test_yaml_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.yaml"
            path.write_text("resolution: 0.05\norigin: [-1.0, 2.5, 0.3]\n")
            self.assertEqual(parse_map_yaml(path), {
                "resolution": 0.05, "originX": -1.0,
                "originY": 2.5, "originYaw": 0.3,
            })

    def test_yaml_image_is_rewritten_after_atomic_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.yaml"
            path.write_text("image: .temporary.pgm\nresolution: 0.05\norigin: [0,0,0]\n")
            rewrite_map_yaml_image(path, "factory_01.pgm")
            self.assertIn("image: factory_01.pgm", path.read_text())

    def test_multipart_contains_contract_fields_and_header_safe_file(self):
        with tempfile.TemporaryDirectory() as directory:
            pgm = Path(directory) / "map.pgm"
            original = b"P5\n3 2\n255\n\x01\x02\x03\x04\x05\x06"
            pgm.write_bytes(original)
            body, boundary = encode_multipart(
                {"robotId": "orinka_01", "resolution": 0.05}, pgm, "BOUNDARY"
            )
            self.assertEqual(boundary, "BOUNDARY")
            self.assertIn(b'name="robotId"\r\n\r\norinka_01', body)
            self.assertIn(b'name="file"; filename="map.pgm"', body)
            self.assertIn(b"Content-Type: image/x-portable-graymap", body)
            self.assertIn(original, body)

    def test_rejects_unsafe_empty_name(self):
        with self.assertRaises(ValueError):
            safe_map_name("../../")


class OrchestratorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.uploads = []

    def tearDown(self):
        self.temporary.cleanup()

    def uploader(self, url, token, pgm_path, fields, timeout):
        self.uploads.append({
            "url": url, "token": token, "pgm": Path(pgm_path).read_bytes(),
            "fields": fields, "timeout": timeout,
        })
        return 201

    def make(self, launch=None, save=None, uploader=None):
        return MappingOrchestrator(
            robot_id="orinka_01",
            upload_url="http://127.0.0.1/maps/upload",
            token="test-token",
            map_dir=self.directory / "maps",
            state_file=self.directory / "state.json",
            launch_command=launch,
            save_command=save or command("save"),
            uploader=uploader or self.uploader,
        )

    async def test_natural_completion_uploads_before_event(self):
        orchestrator = self.make(launch=command("natural"))
        accepted, _ = await orchestrator.start("factory_01")
        self.assertTrue(accepted)
        await wait_for_state(orchestrator, MappingState.COMPLETED)
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.uploads[0]["fields"]["widthPx"], 2)
        self.assertEqual(
            self.uploads[0]["pgm"], b"P5\n2 2\n255\n\x00\x40\x80\xff"
        )
        event = orchestrator.peek_completion_event()
        self.assertEqual(event["type"], "EVENT_MAPPING_COMPLETE")
        self.assertEqual(event["name"], "factory_01")

    async def test_duplicate_start_is_rejected(self):
        orchestrator = self.make(launch=command("sleep"))
        self.assertTrue((await orchestrator.start("one"))[0])
        accepted, reason = await orchestrator.start("two")
        self.assertFalse(accepted)
        self.assertIn("already active", reason)
        await orchestrator.stop()

    async def test_duplicate_save_is_rejected(self):
        orchestrator = self.make(save=command("sleep"))
        self.assertTrue((await orchestrator.save("one"))[0])
        accepted, reason = await orchestrator.save("one")
        self.assertFalse(accepted)
        self.assertIn("already active", reason)
        await orchestrator.stop()

    async def test_stop_terminates_owned_exploration_only(self):
        orchestrator = self.make(launch=command("sleep"))
        await orchestrator.start("one")
        process = orchestrator._process
        accepted, _ = await orchestrator.stop()
        self.assertTrue(accepted)
        self.assertIsNotNone(process.returncode)
        self.assertEqual(orchestrator.state, MappingState.IDLE)
        self.assertIsNone(orchestrator.peek_completion_event())

    async def test_upload_failure_never_creates_event(self):
        def fail(*args):
            raise OSError("mock upload failure")

        orchestrator = self.make(uploader=fail)
        await orchestrator.save("failed")
        await wait_for_state(orchestrator, MappingState.FAILED)
        self.assertIsNone(orchestrator.peek_completion_event())

    async def test_completion_event_is_persisted_and_sent_once(self):
        orchestrator = self.make()
        await orchestrator.save("persisted")
        await wait_for_state(orchestrator, MappingState.COMPLETED)
        restored = self.make()
        self.assertIsNotNone(restored.peek_completion_event())
        accepted, reason = await restored.start("must_wait")
        self.assertFalse(accepted)
        self.assertIn("pending", reason)
        restored.mark_completion_event_sent()
        self.assertIsNone(restored.peek_completion_event())
        restored_again = self.make()
        self.assertIsNone(restored_again.peek_completion_event())

    async def test_missing_token_rejects_before_launch(self):
        orchestrator = self.make(launch=command("sleep"))
        orchestrator.token = None
        accepted, reason = await orchestrator.start("one")
        self.assertFalse(accepted)
        self.assertIn("token", reason)
        self.assertIsNone(orchestrator._process)


if __name__ == "__main__":
    unittest.main()
