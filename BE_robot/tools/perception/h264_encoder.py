#!/usr/bin/env python3
"""Single x264 encode feeding both live binary transport and MP4 segments."""

import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time

ROBOT_ROOT = Path(__file__).resolve().parents[2]


def _load_protocol():
    candidates = [
        os.environ.get("ORINCAR_DASHBOARD_DIR"),
        str(ROBOT_ROOT / "orin_dashboard"),
        "/home/e101/orin_dashboard",
    ]
    for candidate in candidates:
        if candidate and candidate not in sys.path:
            sys.path.insert(0, candidate)
    try:
        from h264_protocol import H264Packet, encode_packet
    except ImportError as exc:
        raise RuntimeError("h264_protocol.py is unavailable") from exc
    return H264Packet, encode_packet


def _atomic_write(path, data, binary=False):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    if binary:
        temporary.write_bytes(data)
    else:
        temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def load_gstreamer():
    try:
        import gi
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
    except (ImportError, ValueError) as exc:
        raise RuntimeError("GStreamer Python bindings are unavailable") from exc
    Gst.init(None)
    return Gst


class H264Encoder:
    def __init__(
        self,
        robot_id,
        frame_file="/dev/shm/orincar_h264.bin",
        directory="~/.local/state/bbiyong/blackbox_h264",
        manifest_path="~/.local/state/bbiyong/blackbox/manifest.json",
        width=640,
        height=480,
        fps=15,
        bitrate_kbps=1200,
        key_interval=30,
        segment_seconds=10,
        retention_seconds=300,
        record_enabled=True,
        gst_module=None,
        clock=time.time,
    ):
        self.robot_id = robot_id
        self.frame_file = Path(frame_file).expanduser()
        self.directory = Path(directory).expanduser().resolve()
        self.manifest_path = Path(manifest_path).expanduser()
        self.width = int(width)
        self.height = int(height)
        self.fps = int(fps)
        self.bitrate_kbps = int(bitrate_kbps)
        self.key_interval = int(key_interval)
        self.segment_seconds = int(segment_seconds)
        self.retention_seconds = int(retention_seconds)
        self.record_enabled = bool(record_enabled)
        self.clock = clock
        if (self.width, self.height, self.fps) != (640, 480, 15):
            raise ValueError("H.264 mode currently requires 640x480 at 15 FPS")
        if not 100 <= self.bitrate_kbps <= 10_000:
            raise ValueError("H.264 bitrate must be between 100 and 10000 Kbps")
        if not 1 <= self.key_interval <= 300:
            raise ValueError("H.264 key interval must be between 1 and 300")

        self.Packet, self.encode_packet = _load_protocol()

        self.Gst = gst_module or load_gstreamer()
        self.stream_id = secrets.randbits(32)
        self.sequence = 0
        self.input_sequence = 0
        self.frame_duration = self.Gst.SECOND // self.fps
        self.started_at = self.clock()
        self._stop = threading.Event()
        self._segments = self._load_segments()
        self.directory.mkdir(parents=True, exist_ok=True)
        location = str(self.directory / "segment-%05d.mp4").replace("\\", "/")
        pipeline = (
            "appsrc name=source is-live=true block=false format=time do-timestamp=false "
            f"caps=video/x-raw,format=BGR,width={self.width},height={self.height},framerate={self.fps}/1 "
            "! queue leaky=downstream max-size-buffers=2 "
            "! videoconvert ! video/x-raw,format=I420 "
            f"! x264enc speed-preset=veryfast tune=zerolatency bitrate={self.bitrate_kbps} "
            f"key-int-max={self.key_interval} bframes=0 byte-stream=true aud=true "
            "! tee name=encoded "
            "encoded. ! queue leaky=downstream max-size-buffers=2 "
            "! h264parse config-interval=-1 "
            "! video/x-h264,stream-format=byte-stream,alignment=au "
            "! appsink name=stream emit-signals=true sync=false max-buffers=2 drop=true "
        )
        if self.record_enabled:
            pipeline += (
                "encoded. ! queue ! h264parse "
                "! video/x-h264,stream-format=avc,alignment=au "
                f"! splitmuxsink name=recorder location={location} "
                f"max-size-time={self.segment_seconds * 1_000_000_000} "
                "muxer-factory=mp4mux async-finalize=true send-keyframe-requests=true"
            )
        try:
            self.pipeline = self.Gst.parse_launch(pipeline)
            self.source = self.pipeline.get_by_name("source")
            self.sink = self.pipeline.get_by_name("stream")
            self.sink.connect("new-sample", self._on_sample)
            self.bus = self.pipeline.get_bus()
            result = self.pipeline.set_state(self.Gst.State.PLAYING)
            if result == self.Gst.StateChangeReturn.FAILURE:
                raise RuntimeError("GStreamer x264 pipeline failed to start")
        except Exception:
            try:
                self.pipeline.set_state(self.Gst.State.NULL)
            except Exception:
                pass
            raise
        self._bus_thread = threading.Thread(target=self._watch_bus, daemon=True)
        self._bus_thread.start()

    def _load_segments(self):
        try:
            payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            return [item for item in payload.get("segments", []) if Path(item["path"]).is_file()]
        except (OSError, ValueError, KeyError, TypeError):
            return []

    def add_frame(self, frame, stamp=None):
        if tuple(frame.shape[1::-1]) != (self.width, self.height):
            raise ValueError("H.264 input frame must be 640x480")
        data = frame.tobytes()
        buffer = self.Gst.Buffer.new_allocate(None, len(data), None)
        buffer.fill(0, data)
        buffer.pts = self.input_sequence * self.frame_duration
        buffer.dts = buffer.pts
        buffer.duration = self.frame_duration
        self.input_sequence += 1
        result = self.source.emit("push-buffer", buffer)
        if result != self.Gst.FlowReturn.OK:
            raise RuntimeError(f"H.264 appsrc rejected frame: {result}")

    def _on_sample(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return self.Gst.FlowReturn.ERROR
        buffer = sample.get_buffer()
        ok, mapped = buffer.map(self.Gst.MapFlags.READ)
        if not ok:
            return self.Gst.FlowReturn.ERROR
        try:
            payload = bytes(mapped.data)
        finally:
            buffer.unmap(mapped)
        keyframe = not buffer.has_flags(self.Gst.BufferFlags.DELTA_UNIT)
        packet = self.encode_packet(self.Packet(
            robot_id=self.robot_id,
            stream_id=self.stream_id,
            sequence=self.sequence,
            timestamp_ms=int(self.clock() * 1000),
            width=self.width,
            height=self.height,
            fps=self.fps,
            keyframe=keyframe,
            codec_config=keyframe,
            payload=payload,
        ))
        _atomic_write(self.frame_file, packet, binary=True)
        self.sequence += 1
        return self.Gst.FlowReturn.OK

    def _watch_bus(self):
        mask = self.Gst.MessageType.ERROR | self.Gst.MessageType.ELEMENT
        while not self._stop.is_set():
            message = self.bus.timed_pop_filtered(500 * self.Gst.MSECOND, mask)
            if message is None:
                continue
            if message.type == self.Gst.MessageType.ERROR:
                error, debug = message.parse_error()
                print(f"[h264] GStreamer error: {error} ({debug})", flush=True)
                continue
            structure = message.get_structure()
            if structure is None or structure.get_name() != "splitmuxsink-fragment-closed":
                continue
            location = structure.get_string("location")
            ok, running_time = structure.get_uint64("running-time")
            if location and ok:
                self._record_segment(location, running_time / self.Gst.SECOND)

    def _record_segment(self, location, ended_offset):
        path = Path(location).expanduser()
        if not path.is_file() or path.stat().st_size <= 0:
            return
        ended_at = self.started_at + float(ended_offset)
        started_at = (
            float(self._segments[-1]["endedAt"])
            if self._segments else max(self.started_at, ended_at - self.segment_seconds)
        )
        self._segments.append({
            "path": str(path),
            "startedAt": started_at,
            "endedAt": ended_at,
            "durationSec": max(0, round(ended_at - started_at)),
            "codec": "h264",
        })
        cutoff = ended_at - self.retention_seconds
        retained = []
        for item in self._segments:
            item_path = Path(item["path"]).expanduser().resolve()
            if float(item.get("endedAt", 0)) < cutoff and item_path.parent == self.directory:
                try:
                    item_path.unlink(missing_ok=True)
                except OSError:
                    retained.append(item)
            else:
                retained.append(item)
        self._segments = retained
        _atomic_write(self.manifest_path, {
            "version": 1,
            "updatedAt": self.clock(),
            "codec": "h264",
            "segments": self._segments,
        })

    def close(self):
        try:
            self.source.emit("end-of-stream")
            self.bus.timed_pop_filtered(5 * self.Gst.SECOND, self.Gst.MessageType.EOS)
        finally:
            self._stop.set()
            self.pipeline.set_state(self.Gst.State.NULL)
            self._bus_thread.join(timeout=1.0)
