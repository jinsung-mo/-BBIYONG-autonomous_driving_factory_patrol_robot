import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from event_clip_pipeline import (
    EventClipPipeline,
    MultipartVideoUploader,
    select_segment,
    validate_event_saved,
)


class FakeUploader:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def upload(self, robot_id, event_id, segment):
        self.calls.append((robot_id, event_id, segment))
        if self.error:
            raise self.error
        return 201


class EventCommandTest(unittest.TestCase):
    def test_validates_exact_backend_payload(self):
        self.assertEqual(
            validate_event_saved({"command": "EVENT_SAVED", "eventId": 42, "type": "fire"}),
            (42, "FIRE"),
        )

    def test_rejects_malformed_event_id_and_type(self):
        for event_id in (None, True, 0, -1, 1.0, "1"):
            with self.subTest(event_id=event_id), self.assertRaises(ValueError):
                validate_event_saved({"eventId": event_id, "type": "FIRE"})
        with self.assertRaises(ValueError):
            validate_event_saved({"eventId": 1, "type": ""})


class SegmentSelectionTest(unittest.TestCase):
    def test_selects_segment_containing_event(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.mp4"
            second = root / "second.mp4"
            first.write_bytes(b"one")
            second.write_bytes(b"two")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"segments": [
                {"path": str(first), "startedAt": 10, "endedAt": 20},
                {"path": str(second), "startedAt": 21, "endedAt": 30},
            ]}))
            selected = select_segment(manifest, 25)
            self.assertEqual(selected["path"], second)
            self.assertEqual(selected["distance"], 0)


class MultipartUploaderTest(unittest.TestCase):
    class Response:
        status = 201

        @staticmethod
        def read(_limit):
            return b"{}"

    class Connection:
        latest = None

        def __init__(self, host, port, timeout):
            self.host = host
            self.port = port
            self.timeout = timeout
            self.headers = {}
            self.body = bytearray()
            type(self).latest = self

        def putrequest(self, method, path):
            self.method = method
            self.path = path

        def putheader(self, name, value):
            self.headers[name] = value

        def endheaders(self):
            pass

        def send(self, value):
            self.body.extend(value)

        def getresponse(self):
            return MultipartUploaderTest.Response()

        def close(self):
            pass

    def test_streams_backend_contract_fields_and_auth_header(self):
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "event.mp4"
            clip.write_bytes(b"video-bytes")
            uploader = MultipartVideoUploader(
                "http://backend.test/api/videos/upload", token="robot-secret"
            )
            with patch(
                "event_clip_pipeline.http.client.HTTPConnection", self.Connection
            ):
                status = uploader.upload("robot-1", 17, {
                    "path": clip, "startedAt": 100, "endedAt": 110,
                    "durationSec": 10,
                })
            connection = self.Connection.latest
            body = bytes(connection.body)
            self.assertEqual(status, 201)
            self.assertEqual(connection.path, "/api/videos/upload")
            self.assertEqual(connection.headers["X-Robot-Token"], "robot-secret")
            for name, value in (
                (b' name="file"', b"video-bytes"),
                (b' name="robotId"', b"robot-1"),
                (b' name="eventId"', b"17"),
                (b' name="clipType"', b"EVENT"),
                (b' name="durationSec"', b"10"),
                (b' name="startedAt"', b"1970-01-01T00:01:40Z"),
                (b' name="endedAt"', b"1970-01-01T00:01:50Z"),
            ):
                self.assertIn(name, body)
                self.assertIn(value, body)

    def test_rejects_clip_over_configured_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "large.mp4"
            clip.write_bytes(b"12345")
            uploader = MultipartVideoUploader(
                "http://backend.test/api/videos/upload", token="token", max_bytes=4
            )
            with self.assertRaisesRegex(ValueError, "exceeds"):
                uploader.upload("robot-1", 1, {
                    "path": clip, "startedAt": 1, "endedAt": 2,
                    "durationSec": 1,
                })


class PipelineTest(unittest.IsolatedAsyncioTestCase):
    def make_pipeline(self, root, uploader, clock):
        return EventClipPipeline(
            "robot-1",
            root / "queue.json",
            root / "manifest.json",
            uploader,
            poll_seconds=1,
            clip_wait_seconds=2,
            retry_base_seconds=5,
            clock=lambda: clock[0],
        )

    async def test_uploads_event_clip_and_persists_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "event.mp4"
            clip.write_bytes(b"video")
            (root / "manifest.json").write_text(json.dumps({"segments": [{
                "path": str(clip), "startedAt": 95, "endedAt": 105,
                "durationSec": 10,
            }]}))
            clock = [100.0]
            uploader = FakeUploader()
            pipeline = self.make_pipeline(root, uploader, clock)
            pipeline.note_event("EVENT_FIRE", 100.0)
            self.assertTrue(pipeline.enqueue(
                {"command": "EVENT_SAVED", "eventId": 7, "type": "FIRE"}, 101.0
            ))
            self.assertFalse(pipeline.enqueue(
                {"command": "EVENT_SAVED", "eventId": 7, "type": "FIRE"}, 101.0
            ))

            clock[0] = 101.0
            await pipeline.process_once()

            self.assertEqual(len(uploader.calls), 1)
            self.assertEqual(uploader.calls[0][1], 7)
            saved = json.loads((root / "queue.json").read_text())
            self.assertEqual(saved["jobs"]["7"]["status"], "uploaded")
            self.assertEqual(saved["jobs"]["7"]["eventAt"], 100.0)

    async def test_failure_is_durable_and_retried_after_backoff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "event.mp4"
            clip.write_bytes(b"video")
            (root / "manifest.json").write_text(json.dumps({"segments": [{
                "path": str(clip), "startedAt": 95, "endedAt": 105,
            }]}))
            clock = [100.0]
            failing = FakeUploader(RuntimeError("offline"))
            pipeline = self.make_pipeline(root, failing, clock)
            pipeline.enqueue({"eventId": 8, "type": "OVERHEAT"}, 100.0)
            await pipeline.process_once()
            self.assertEqual(pipeline.state["jobs"]["8"]["status"], "retry")
            self.assertEqual(pipeline.state["jobs"]["8"]["attempts"], 1)
            staged = Path(pipeline.state["jobs"]["8"]["stagedSegment"]["path"])
            self.assertTrue(staged.is_file())

            # The rolling recorder may prune its source while the robot is offline.
            clip.unlink()
            (root / "manifest.json").unlink()

            recovered = FakeUploader()
            pipeline = self.make_pipeline(root, recovered, clock)
            await pipeline.process_once()
            self.assertEqual(recovered.calls, [])
            clock[0] = 105.0
            await pipeline.process_once()
            self.assertEqual(len(recovered.calls), 1)
            self.assertEqual(pipeline.state["jobs"]["8"]["status"], "uploaded")

    async def test_waits_for_finalized_matching_clip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "old.mp4"
            old.write_bytes(b"old")
            (root / "manifest.json").write_text(json.dumps({"segments": [{
                "path": str(old), "startedAt": 1, "endedAt": 2,
            }]}))
            clock = [100.0]
            uploader = FakeUploader()
            pipeline = self.make_pipeline(root, uploader, clock)
            pipeline.enqueue({"eventId": 9, "type": "FIRE"}, 100.0)
            await pipeline.process_once()
            self.assertEqual(uploader.calls, [])
            self.assertEqual(pipeline.state["jobs"]["9"]["status"], "waiting_for_clip")


if __name__ == "__main__":
    unittest.main()
