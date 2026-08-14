#!/usr/bin/env python3
"""Bounded, camera-owned rolling video recorder.

The camera process is the only owner of ``/dev/video0``.  It records short,
finalized MP4 segments and atomically publishes a manifest for the cloud bridge.
"""

import json
import os
from pathlib import Path
import time


def _atomic_json(path, payload):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


class BlackboxRecorder:
    def __init__(
        self,
        cv2_module,
        directory,
        manifest_path,
        width=640,
        height=480,
        fps=10.0,
        segment_seconds=10.0,
        retention_seconds=300.0,
        clock=time.time,
    ):
        self.cv2 = cv2_module
        self.directory = Path(directory).expanduser().resolve()
        self.manifest_path = Path(manifest_path).expanduser()
        self.width = int(width)
        self.height = int(height)
        self.fps = float(fps)
        self.segment_seconds = float(segment_seconds)
        self.retention_seconds = float(retention_seconds)
        self.clock = clock
        self.writer = None
        self.active_path = None
        self.started_at = None
        self.frame_count = 0
        self.segments = []
        self.directory.mkdir(parents=True, exist_ok=True)
        self._load_manifest()

    def _load_manifest(self):
        try:
            payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            entries = payload.get("segments", [])
            self.segments = [item for item in entries if Path(item["path"]).is_file()]
        except (OSError, ValueError, KeyError, TypeError):
            self.segments = []

    def _publish_manifest(self):
        _atomic_json(
            self.manifest_path,
            {"version": 1, "updatedAt": self.clock(), "segments": self.segments},
        )

    def _start(self, stamp):
        self.directory.mkdir(parents=True, exist_ok=True)
        self.active_path = self.directory / f"segment-{int(stamp * 1000)}.mp4"
        fourcc = self.cv2.VideoWriter_fourcc(*"mp4v")
        self.writer = self.cv2.VideoWriter(
            str(self.active_path), fourcc, self.fps, (self.width, self.height)
        )
        if not self.writer.isOpened():
            self.writer.release()
            self.writer = None
            raise RuntimeError(f"cannot open blackbox writer: {self.active_path}")
        self.started_at = stamp
        self.frame_count = 0

    def add_frame(self, frame, stamp=None):
        stamp = self.clock() if stamp is None else float(stamp)
        if self.writer is not None and stamp - self.started_at >= self.segment_seconds:
            self._finalize(stamp)
        if self.writer is None:
            self._start(stamp)
        image = frame
        if tuple(frame.shape[1::-1]) != (self.width, self.height):
            image = self.cv2.resize(frame, (self.width, self.height))
        self.writer.write(image)
        self.frame_count += 1

    def _finalize(self, ended_at):
        if self.writer is None:
            return
        ended_at = max(float(ended_at), float(self.started_at))
        self.writer.release()
        path = self.active_path
        started_at = self.started_at
        frame_count = self.frame_count
        self.writer = None
        self.active_path = None
        self.started_at = None
        self.frame_count = 0
        if path.is_file() and path.stat().st_size > 0 and frame_count > 0:
            self.segments.append(
                {
                    "path": str(path),
                    "startedAt": started_at,
                    "endedAt": ended_at,
                    "durationSec": max(0, round(ended_at - started_at)),
                    "frameCount": frame_count,
                }
            )
        self._prune(ended_at)
        self._publish_manifest()

    def _prune(self, now):
        cutoff = now - self.retention_seconds
        retained = []
        for entry in self.segments:
            path = Path(entry["path"]).expanduser().resolve()
            if float(entry.get("endedAt", 0)) < cutoff:
                # Never unlink a path outside the configured blackbox directory.
                if path.parent == self.directory:
                    try:
                        path.unlink(missing_ok=True)
                    except OSError:
                        retained.append(entry)
                continue
            retained.append(entry)
        self.segments = retained

    def close(self):
        self._finalize(self.clock())
