import json
from pathlib import Path
import tempfile
import unittest

from blackbox_recorder import BlackboxRecorder


class Frame:
    shape = (480, 640, 3)


class FakeWriter:
    def __init__(self, path):
        self.path = Path(path)
        self.path.write_bytes(b"")

    def isOpened(self):
        return True

    def write(self, _frame):
        with self.path.open("ab") as output:
            output.write(b"frame")

    def release(self):
        pass


class FakeCv2:
    @staticmethod
    def VideoWriter_fourcc(*_codec):
        return 1

    @staticmethod
    def VideoWriter(path, _fourcc, _fps, _size):
        return FakeWriter(path)

    @staticmethod
    def resize(frame, _size):
        return frame


class BlackboxRecorderTest(unittest.TestCase):
    def test_finalizes_segments_and_atomically_publishes_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clock = [10.0]
            recorder = BlackboxRecorder(
                FakeCv2,
                root / "clips",
                root / "manifest.json",
                segment_seconds=5,
                retention_seconds=60,
                clock=lambda: clock[0],
            )
            recorder.add_frame(Frame(), 10)
            recorder.add_frame(Frame(), 16)
            recorder.close()
            manifest = json.loads((root / "manifest.json").read_text())
            self.assertEqual(len(manifest["segments"]), 2)
            self.assertEqual(manifest["segments"][0]["startedAt"], 10)
            self.assertFalse((root / "manifest.json.tmp").exists())

    def test_prunes_only_files_inside_blackbox_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inside = root / "clips" / "old.mp4"
            outside = root / "outside.mp4"
            inside.parent.mkdir()
            inside.write_bytes(b"old")
            outside.write_bytes(b"keep")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"segments": [
                {"path": str(inside), "startedAt": 1, "endedAt": 2},
                {"path": str(outside), "startedAt": 1, "endedAt": 2},
            ]}))
            recorder = BlackboxRecorder(
                FakeCv2, root / "clips", manifest,
                retention_seconds=10, clock=lambda: 100,
            )
            recorder.add_frame(Frame(), 100)
            recorder.close()
            self.assertFalse(inside.exists())
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
