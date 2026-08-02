#!/usr/bin/env python3
"""Backend-driven mapping orchestration for the Orin cloud bridge.

This module intentionally owns only subprocesses that it starts.  The base robot
stack (LiDAR, odometry, motor bridge, and slam_toolbox) remains externally owned.
"""

import asyncio
import json
import os
from pathlib import Path
import re
import shlex
import struct
import time
from enum import Enum
from urllib import request
import uuid
import zlib

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows unit-test host
    fcntl = None


class MappingState(str, Enum):
    IDLE = "IDLE"
    STARTING = "STARTING"
    MAPPING = "MAPPING"
    SAVING = "SAVING"
    UPLOADING = "UPLOADING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    STOPPING = "STOPPING"


def safe_map_name(value):
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    name = name.strip("._-")
    if not name or name in (".", ".."):
        raise ValueError("map name must contain at least one safe character")
    return name[:80]


def parse_map_yaml(path):
    """Read the small ROS map YAML subset without adding a runtime dependency."""
    values = {}
    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    try:
        resolution = float(values["resolution"])
        origin_text = values["origin"].strip()
        if not (origin_text.startswith("[") and origin_text.endswith("]")):
            raise ValueError("origin must be a three-item list")
        origin = [float(item.strip()) for item in origin_text[1:-1].split(",")]
        if len(origin) != 3:
            raise ValueError("origin must contain x, y, and yaw")
    except (KeyError, ValueError) as exc:
        raise ValueError(f"invalid ROS map YAML {path}: {exc}") from exc
    return {
        "resolution": resolution,
        "originX": origin[0],
        "originY": origin[1],
        "originYaw": origin[2],
    }


def rewrite_map_yaml_image(path, image_name):
    """Keep the ROS YAML loadable after temporary artifacts are promoted."""
    target = Path(path)
    lines = target.read_text(encoding="utf-8").splitlines()
    replaced = False
    for index, line in enumerate(lines):
        if re.match(r"^\s*image\s*:", line):
            lines[index] = f"image: {image_name}"
            replaced = True
            break
    if not replaced:
        lines.insert(0, f"image: {image_name}")
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temporary, target)


def _pgm_token(stream):
    token = bytearray()
    while True:
        char = stream.read(1)
        if not char:
            break
        if char == b"#":
            stream.readline()
            if token:
                break
            continue
        if char.isspace():
            if token:
                break
            continue
        token.extend(char)
    if not token:
        raise ValueError("truncated PGM header")
    return bytes(token)


def read_pgm(path):
    with Path(path).open("rb") as stream:
        magic = _pgm_token(stream)
        width = int(_pgm_token(stream))
        height = int(_pgm_token(stream))
        maximum = int(_pgm_token(stream))
        if width <= 0 or height <= 0 or not 0 < maximum <= 65535:
            raise ValueError("invalid PGM dimensions or maximum value")
        count = width * height
        if magic == b"P5":
            sample_bytes = 1 if maximum < 256 else 2
            raw = stream.read(count * sample_bytes)
            if len(raw) != count * sample_bytes:
                raise ValueError("truncated PGM pixels")
            samples = raw if sample_bytes == 1 else bytes(
                round(int.from_bytes(raw[i:i + 2], "big") * 255 / maximum)
                for i in range(0, len(raw), 2)
            )
        elif magic == b"P2":
            samples = bytes(round(int(_pgm_token(stream)) * 255 / maximum)
                            for _ in range(count))
        else:
            raise ValueError(f"unsupported PGM magic {magic!r}")
        if maximum != 255 and magic == b"P5" and maximum < 256:
            samples = bytes(round(value * 255 / maximum) for value in samples)
        return width, height, samples


def _png_chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def convert_pgm_to_png(pgm_path, png_path):
    """Convert without flipping rows so occupancy-grid orientation is preserved."""
    width, height, pixels = read_pgm(pgm_path)
    rows = b"".join(
        b"\x00" + pixels[row * width:(row + 1) * width]
        for row in range(height)
    )
    payload = (b"\x89PNG\r\n\x1a\n"
               + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
               + _png_chunk(b"IDAT", zlib.compress(rows))
               + _png_chunk(b"IEND", b""))
    target = Path(png_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, target)
    return width, height


def encode_multipart(fields, file_path, boundary=None):
    boundary = boundary or ("----bbiyong-" + uuid.uuid4().hex)
    marker = boundary.encode("ascii")
    chunks = []
    for key, value in fields.items():
        chunks.extend([
            b"--" + marker + b"\r\n",
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"),
            str(value).encode("utf-8"), b"\r\n",
        ])
    file_path = Path(file_path)
    chunks.extend([
        b"--" + marker + b"\r\n",
        (f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
         'Content-Type: image/png\r\n\r\n').encode("utf-8"),
        file_path.read_bytes(), b"\r\n", b"--" + marker + b"--\r\n",
    ])
    return b"".join(chunks), boundary


def upload_map(url, token, png_path, fields, timeout=20.0):
    if not token:
        raise RuntimeError("BBIYONG_ROBOT_UPLOAD_TOKEN is not configured")
    body, boundary = encode_multipart(fields, png_path)
    upload = request.Request(url, data=body, method="POST", headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "X-Robot-Token": token,
    })
    with request.urlopen(upload, timeout=timeout) as response:
        status = response.status
        response.read()
    if status != 201:
        raise RuntimeError(f"map upload returned HTTP {status}, expected 201")
    return status


class MappingOrchestrator:
    """Serialize mapping, saving, upload, and completion-event production."""

    ACTIVE = {MappingState.STARTING, MappingState.MAPPING, MappingState.SAVING,
              MappingState.UPLOADING, MappingState.STOPPING}

    def __init__(self, robot_id, upload_url, token, map_dir, state_file,
                 launch_command=None, save_command=None, upload_timeout=20.0,
                 uploader=upload_map):
        self.robot_id = robot_id
        self.upload_url = upload_url
        self.token = token
        self.map_dir = Path(map_dir).expanduser()
        self.state_file = Path(state_file).expanduser()
        self.launch_command = launch_command
        self.save_command = save_command
        self.upload_timeout = upload_timeout
        self.uploader = uploader
        self.state = MappingState.IDLE
        self.error = None
        self._operation = None
        self._process = None
        self._save_process = None
        self._monitor_task = None
        self._pipeline_task = None
        self._lock = asyncio.Lock()
        self._stopping = False
        self._expected_process_exit = False
        self._completion = None
        self._load_state()

    @property
    def telemetry_status(self):
        return "MAPPING" if self.state in self.ACTIVE else None

    def _load_state(self):
        try:
            saved = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        self._completion = saved.get("completion")
        previous = saved.get("state")
        if previous in {item.value for item in self.ACTIVE}:
            self.state = MappingState.FAILED
            self.error = "bridge restarted during an active mapping operation"
        elif previous in {item.value for item in MappingState}:
            self.state = MappingState(previous)

    def _persist(self):
        payload = {
            "state": self.state.value,
            "error": self.error,
            "operation": self._operation,
            "completion": self._completion,
        }
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_file.with_name(self.state_file.name + ".tmp")
        temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        os.replace(temporary, self.state_file)

    def _transition(self, state, error=None):
        old = self.state
        self.state = state
        self.error = error
        self._persist()
        print(f"[mapping] state {old.value} -> {state.value}"
              + (f" error={error}" if error else ""), flush=True)

    def peek_completion_event(self):
        return dict(self._completion) if self._completion else None

    def mark_completion_event_sent(self):
        if self._completion:
            print(f"[mapping] completion event sent name={self._completion['name']}",
                  flush=True)
            self._completion = None
            self._persist()

    async def handle_command(self, command):
        kind = (command.get("command") or "").upper()
        if kind == "START_MAPPING":
            return await self.start(command.get("name"))
        if kind == "STOP_MAPPING":
            return await self.stop()
        if kind == "SAVE_MAP":
            return await self.save(command.get("name"))
        return False, f"unsupported mapping command {kind}"

    async def start(self, name=None):
        async with self._lock:
            if self.state in self.ACTIVE:
                return False, f"mapping already active ({self.state.value})"
            if self._completion:
                return False, "completion event is still pending delivery"
            if not self.token:
                return False, "mapping upload token is not configured"
            if self._another_explorer_is_running():
                return False, "another frontier_explorer is already running"
            name = safe_map_name(name or time.strftime("map_%Y%m%d_%H%M%S"))
            operation_id = uuid.uuid4().hex[:12]
            work_base = self.map_dir / f".{name}.{operation_id}"
            self._operation = {"id": operation_id, "name": name,
                               "workBase": str(work_base)}
            self._stopping = False
            self._expected_process_exit = False
            self._transition(MappingState.STARTING)
            command = self._launch_args(work_base)
            try:
                self._process = await asyncio.create_subprocess_exec(*command)
            except Exception as exc:
                self._transition(MappingState.FAILED, f"exploration launch failed: {exc}")
                return False, self.error
            self._transition(MappingState.MAPPING)
            self._monitor_task = asyncio.create_task(self._monitor_exploration())
            return True, f"mapping started as {name}"

    @staticmethod
    def _another_explorer_is_running():
        if fcntl is None:
            return False
        lock = open("/tmp/bbiyong_frontier_explorer.lock", "a+", encoding="utf-8")
        try:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            finally:
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            return False
        finally:
            lock.close()

    def _launch_args(self, work_base):
        if self.launch_command:
            args = shlex.split(self.launch_command)
            return [part.format(map_output=str(work_base)) for part in args]
        return ["ros2", "launch", "bbiyong_bringup", "exploration.launch.py",
                f"map_output:={work_base}"]

    def _save_args(self, work_base):
        if self.save_command:
            args = shlex.split(self.save_command)
            return [part.format(map_output=str(work_base)) for part in args]
        return ["ros2", "run", "bbiyong_bringup", "save_map", str(work_base),
                "--overwrite"]

    async def _monitor_exploration(self):
        return_code = await self._process.wait()
        if self._stopping or self._expected_process_exit:
            return
        if return_code != 0:
            self._transition(MappingState.FAILED,
                             f"exploration exited with status {return_code}")
            return
        await self.save(self._operation["name"])

    async def save(self, name=None):
        async with self._lock:
            if self.state in (MappingState.SAVING, MappingState.UPLOADING):
                return False, f"map save already active ({self.state.value})"
            if self._completion:
                return False, "completion event is still pending delivery"
            if self.state not in (MappingState.MAPPING, MappingState.COMPLETED,
                                  MappingState.FAILED, MappingState.IDLE):
                return False, f"cannot save while {self.state.value}"
            if not self.token:
                return False, "mapping upload token is not configured"
            selected = safe_map_name(name or (self._operation or {}).get("name")
                                     or time.strftime("map_%Y%m%d_%H%M%S"))
            if not self._operation or selected != self._operation.get("name"):
                operation_id = uuid.uuid4().hex[:12]
                self._operation = {
                    "id": operation_id, "name": selected,
                    "workBase": str(self.map_dir / f".{selected}.{operation_id}"),
                }
            if self._process and self._process.returncode is None:
                self._expected_process_exit = True
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    self._process.kill()
                    await self._process.wait()
            self._transition(MappingState.SAVING)
            self._pipeline_task = asyncio.create_task(self._save_upload_pipeline())
            return True, f"saving map as {selected}"

    async def _save_upload_pipeline(self):
        work_base = Path(self._operation["workBase"])
        pgm = Path(f"{work_base}.pgm")
        yaml_path = Path(f"{work_base}.yaml")
        try:
            self.map_dir.mkdir(parents=True, exist_ok=True)
            if not (pgm.is_file() and yaml_path.is_file()):
                self._save_process = await asyncio.create_subprocess_exec(
                    *self._save_args(work_base))
                return_code = await self._save_process.wait()
                if return_code != 0:
                    raise RuntimeError(f"map saver exited with status {return_code}")
            if any(not path.is_file() or path.stat().st_size == 0
                   for path in (pgm, yaml_path)):
                raise RuntimeError("map saver did not create non-empty PGM and YAML")
            metadata = parse_map_yaml(yaml_path)
            final_base = self.map_dir / self._operation["name"]
            final_pgm = Path(f"{final_base}.pgm")
            final_yaml = Path(f"{final_base}.yaml")
            os.replace(pgm, final_pgm)
            os.replace(yaml_path, final_yaml)
            rewrite_map_yaml_image(final_yaml, final_pgm.name)
            png = Path(f"{final_base}.png")
            width, height = await asyncio.to_thread(
                convert_pgm_to_png, final_pgm, png)
            fields = {"robotId": self.robot_id, "name": self._operation["name"],
                      "widthPx": width, "heightPx": height, **metadata}
            if self._stopping:
                return
            self._transition(MappingState.UPLOADING)
            status = await asyncio.to_thread(
                self.uploader, self.upload_url, self.token, png, fields,
                self.upload_timeout)
            if status != 201:
                raise RuntimeError(f"map upload returned HTTP {status}")
            if self._stopping:
                return
            self._completion = {
                "source": "robot", "type": "EVENT_MAPPING_COMPLETE",
                "robot_id": self.robot_id, "name": self._operation["name"],
            }
            self._transition(MappingState.COMPLETED)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._transition(MappingState.FAILED, str(exc))
        finally:
            self._save_process = None

    async def stop(self):
        async with self._lock:
            if self.state not in self.ACTIVE:
                return False, f"mapping is not active ({self.state.value})"
            self._stopping = True
            self._expected_process_exit = True
            self._transition(MappingState.STOPPING)
            for process in (self._save_process, self._process):
                if process and process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
            if self._pipeline_task and not self._pipeline_task.done():
                self._pipeline_task.cancel()
                await asyncio.gather(self._pipeline_task, return_exceptions=True)
            self._transition(MappingState.IDLE)
            return True, "mapping stopped"
