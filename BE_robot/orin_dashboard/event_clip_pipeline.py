#!/usr/bin/env python3
"""Durable EVENT_SAVED to blackbox video upload pipeline."""

import asyncio
from datetime import datetime, timezone
import http.client
import json
import math
import mimetypes
import os
from pathlib import Path
import shutil
import time
from urllib.parse import urlsplit
import uuid


MAX_VIDEO_BYTES = 200 * 1024 * 1024


def atomic_json(path, payload):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def validate_event_saved(command):
    event_id = command.get("eventId")
    if isinstance(event_id, bool) or not isinstance(event_id, int) or event_id <= 0:
        raise ValueError("EVENT_SAVED eventId must be a positive integer")
    event_type = command.get("type")
    if not isinstance(event_type, str) or not event_type.strip():
        raise ValueError("EVENT_SAVED type must be a non-empty string")
    event_type = event_type.strip().upper()
    if len(event_type) > 64:
        raise ValueError("EVENT_SAVED type is too long")
    return event_id, event_type


def _canonical_event_type(value):
    value = str(value).strip().upper()
    if "OVERHEAT" in value:
        return "OVERHEAT"
    if "FIRE" in value:
        return "FIRE"
    return value


def _iso(stamp):
    return datetime.fromtimestamp(float(stamp), tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def select_segment(manifest_path, event_at):
    try:
        payload = json.loads(Path(manifest_path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    candidates = []
    for item in payload.get("segments", []):
        try:
            start = float(item["startedAt"])
            end = float(item["endedAt"])
            path = Path(item["path"]).expanduser()
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end) and start <= end):
            continue
        if not path.is_file():
            continue
        distance = 0.0 if start <= event_at <= end else min(
            abs(event_at - start), abs(event_at - end)
        )
        candidates.append((distance, start, end, path, item))
    if not candidates:
        return None
    distance, start, end, path, item = min(candidates, key=lambda value: value[0])
    return {
        "path": path,
        "startedAt": start,
        "endedAt": end,
        "durationSec": int(item.get("durationSec") or max(0, round(end - start))),
        "distance": distance,
    }


class MultipartVideoUploader:
    def __init__(self, upload_url, token=None, timeout=60.0, max_bytes=MAX_VIDEO_BYTES):
        self.upload_url = upload_url
        self.token = token
        self.timeout = float(timeout)
        self.max_bytes = int(max_bytes)

    def upload(self, robot_id, event_id, segment):
        path = Path(segment["path"])
        size = path.stat().st_size
        if size <= 0:
            raise ValueError("blackbox clip is empty")
        if size > self.max_bytes:
            raise ValueError(f"blackbox clip exceeds {self.max_bytes} bytes")
        if not self.token:
            raise RuntimeError("BBIYONG_ROBOT_UPLOAD_TOKEN is not configured")

        fields = {
            "robotId": robot_id,
            "eventId": str(event_id),
            "clipType": "EVENT",
            "durationSec": str(segment["durationSec"]),
            "startedAt": _iso(segment["startedAt"]),
            "endedAt": _iso(segment["endedAt"]),
        }
        boundary = "----bbiyong-" + uuid.uuid4().hex
        chunks = []
        for name, value in fields.items():
            chunks.append(
                (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\""
                 f"\r\n\r\n{value}\r\n").encode("utf-8")
            )
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        file_header = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{path.name}\"\r\nContent-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
        closing = f"\r\n--{boundary}--\r\n".encode("ascii")
        content_length = sum(map(len, chunks)) + len(file_header) + size + len(closing)

        target = urlsplit(self.upload_url)
        connection_class = (
            http.client.HTTPSConnection if target.scheme == "https"
            else http.client.HTTPConnection
        )
        connection = connection_class(target.hostname, target.port, timeout=self.timeout)
        try:
            request_path = target.path or "/"
            if target.query:
                request_path += "?" + target.query
            connection.putrequest("POST", request_path)
            connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            connection.putheader("Content-Length", str(content_length))
            connection.putheader("X-Robot-Token", self.token)
            connection.endheaders()
            for chunk in chunks:
                connection.send(chunk)
            connection.send(file_header)
            with path.open("rb") as clip:
                while True:
                    block = clip.read(1024 * 1024)
                    if not block:
                        break
                    connection.send(block)
            connection.send(closing)
            response = connection.getresponse()
            body = response.read(4096)
            if not 200 <= response.status < 300:
                raise RuntimeError(
                    f"video upload failed HTTP {response.status}: "
                    f"{body.decode('utf-8', errors='replace')}"
                )
            return response.status
        finally:
            connection.close()


class EventClipPipeline:
    def __init__(
        self,
        robot_id,
        state_file,
        manifest_file,
        uploader,
        poll_seconds=2.0,
        clip_wait_seconds=20.0,
        retry_base_seconds=5.0,
        retry_max_seconds=300.0,
        max_match_distance=15.0,
        spool_dir=None,
        clock=time.time,
    ):
        self.robot_id = robot_id
        self.state_file = Path(state_file).expanduser()
        self.manifest_file = Path(manifest_file).expanduser()
        self.uploader = uploader
        self.poll_seconds = float(poll_seconds)
        self.clip_wait_seconds = float(clip_wait_seconds)
        self.retry_base_seconds = float(retry_base_seconds)
        self.retry_max_seconds = float(retry_max_seconds)
        self.max_match_distance = float(max_match_distance)
        self.spool_dir = (
            Path(spool_dir).expanduser()
            if spool_dir is not None
            else self.state_file.parent / "event_clip_spool"
        )
        self.clock = clock
        self.state = self._load()

    def _load(self):
        try:
            value = json.loads(self.state_file.read_text(encoding="utf-8"))
            if isinstance(value.get("jobs"), dict) and isinstance(value.get("events"), list):
                return value
        except (OSError, ValueError, TypeError):
            pass
        return {"version": 1, "events": [], "jobs": {}}

    def _save(self):
        self.state["updatedAt"] = self.clock()
        atomic_json(self.state_file, self.state)

    def note_event(self, event_type, occurred_at=None):
        event_type = _canonical_event_type(event_type)
        self.state["events"].append(
            {"type": event_type, "occurredAt": self.clock() if occurred_at is None else occurred_at}
        )
        self.state["events"] = self.state["events"][-50:]
        self._save()

    def enqueue(self, command, received_at=None):
        event_id, event_type = validate_event_saved(command)
        event_type = _canonical_event_type(event_type)
        key = str(event_id)
        if key in self.state["jobs"]:
            return False
        received_at = self.clock() if received_at is None else float(received_at)
        event_at = received_at
        for index, event in enumerate(self.state["events"]):
            if _canonical_event_type(event.get("type")) == event_type:
                event_at = float(event["occurredAt"])
                self.state["events"].pop(index)
                break
        self.state["jobs"][key] = {
            "eventId": event_id,
            "eventType": event_type,
            "eventAt": event_at,
            "receivedAt": received_at,
            "status": "pending",
            "attempts": 0,
            "nextAttemptAt": received_at,
            "lastError": None,
        }
        self._save()
        return True

    def _staged_segment(self, job):
        staged = job.get("stagedSegment")
        if not isinstance(staged, dict):
            return None
        try:
            path = Path(staged["path"]).expanduser()
            start = float(staged["startedAt"])
            end = float(staged["endedAt"])
            duration = int(staged["durationSec"])
        except (KeyError, TypeError, ValueError):
            return None
        if not path.is_file():
            return None
        return {
            "path": path,
            "startedAt": start,
            "endedAt": end,
            "durationSec": duration,
            "distance": 0.0,
        }

    def _stage_segment(self, job, segment):
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(segment["path"]).suffix or ".mp4"
        destination = self.spool_dir / f"event-{job['eventId']}{suffix}"
        temporary = destination.with_name(destination.name + ".tmp")
        try:
            with Path(segment["path"]).open("rb") as source, temporary.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        except Exception:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        staged = {
            "path": str(destination),
            "startedAt": segment["startedAt"],
            "endedAt": segment["endedAt"],
            "durationSec": segment["durationSec"],
        }
        job["stagedSegment"] = staged
        self._save()
        return {**staged, "path": destination, "distance": 0.0}

    async def process_once(self):
        now = self.clock()
        for job in self.state["jobs"].values():
            if job["status"] == "uploaded" or float(job["nextAttemptAt"]) > now:
                continue
            segment = self._staged_segment(job)
            already_staged = segment is not None
            if segment is None:
                segment = select_segment(self.manifest_file, float(job["eventAt"]))
            waiting_for_final_segment = (
                segment is not None
                and segment["distance"] > 0
                and now - float(job["receivedAt"]) < self.clip_wait_seconds
            )
            wrong_segment = (
                segment is not None
                and segment["distance"] > self.max_match_distance
            )
            if segment is None or waiting_for_final_segment or wrong_segment:
                job["status"] = "waiting_for_clip"
                job["nextAttemptAt"] = now + self.poll_seconds
                self._save()
                continue
            if not already_staged:
                try:
                    segment = await asyncio.to_thread(self._stage_segment, job, segment)
                except Exception as exc:
                    job["status"] = "retry"
                    job["nextAttemptAt"] = now + self.retry_base_seconds
                    job["lastError"] = f"clip staging failed: {exc}"[:500]
                    self._save()
                    continue
            try:
                await asyncio.to_thread(
                    self.uploader.upload, self.robot_id, job["eventId"], segment
                )
            except Exception as exc:
                job["attempts"] += 1
                delay = min(
                    self.retry_base_seconds * (2 ** (job["attempts"] - 1)),
                    self.retry_max_seconds,
                )
                job["status"] = "retry"
                job["nextAttemptAt"] = now + delay
                job["lastError"] = str(exc)[:500]
                self._save()
                continue
            job["status"] = "uploaded"
            job["uploadedAt"] = self.clock()
            job["nextAttemptAt"] = 0
            job["lastError"] = None
            job["clip"] = str(segment["path"])
            self._save()
            try:
                Path(segment["path"]).unlink(missing_ok=True)
            except OSError:
                pass

    async def run(self):
        while True:
            try:
                await self.process_once()
            except Exception as exc:
                # Queue/manifest failures must never tear down the WebSocket bridge.
                print(f"[event-clip] worker error: {exc}", flush=True)
            await asyncio.sleep(self.poll_seconds)
