"""Redacted, atomic evidence capture for supervised robot commissioning."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import socket
import subprocess
import sys
import time
import uuid


SECRET_KEY = re.compile(
    r"(?i)(password|passwd|pwd|token|secret|api[_-]?key|authorization)"
)
KEY_VALUE_SECRET = re.compile(
    r"(?i)((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*"
    r"[:=]\s*)([^\s,;\]\}]+|\"[^\"]*\"|'[^']*')"
)
BEARER_SECRET = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+\-/]+=*")
URL_SECRET = re.compile(r"(https?://[^\s:/]+:)[^@\s]+(@)")
STAGE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def redact_text(text):
    text = BEARER_SECRET.sub("Bearer <redacted>", str(text))
    text = KEY_VALUE_SECRET.sub(r"\1<redacted>", text)
    return URL_SECRET.sub(r"\1<redacted>\2", text)


def redact_value(value, key=""):
    if SECRET_KEY.search(str(key)):
        return "<redacted>"
    if isinstance(value, dict):
        return {item: redact_value(content, item) for item, content in value.items()}
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def _environment_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return bool(default)
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _run(arguments, timeout=8.0, cwd=None):
    started = time.monotonic()
    try:
        completed = subprocess.run(
            arguments,
            cwd=cwd,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        return {
            "command": shlex.join(arguments),
            "returnCode": completed.returncode,
            "timedOut": False,
            "durationSec": round(time.monotonic() - started, 3),
            "output": redact_text(completed.stdout),
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        output = getattr(exc, "stdout", "") or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        return {
            "command": shlex.join(arguments),
            "returnCode": None,
            "timedOut": isinstance(exc, subprocess.TimeoutExpired),
            "durationSec": round(time.monotonic() - started, 3),
            "output": redact_text(output + f"\n{type(exc).__name__}: {exc}"),
        }


def _write_json(path, payload):
    path.write_text(
        json.dumps(redact_value(payload), indent=2, sort_keys=True),
        encoding="utf-8",
    )


def file_hashes(root):
    result = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative == "sha256.json":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        result[relative] = {"sha256": digest, "size": path.stat().st_size}
    return result


def collect_evidence(
    stage, output_dir, mode=None, log_files=(), release_manifest=None
):
    if not STAGE_NAME.fullmatch(stage):
        raise ValueError("stage must be a lowercase slug")
    output = Path(output_dir).expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"evidence directory already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp-{uuid.uuid4().hex}")
    temporary.mkdir()
    try:
        legacy_navigation = _environment_flag("ORINCAR_NAVIGATION_ENABLED")
        metadata = {
            "schemaVersion": 1,
            "stage": stage,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "hostname": socket.gethostname(),
            "platform": platform.platform(),
            "capabilities": {
                "mapping": _environment_flag("ORINCAR_MAPPING_ENABLED"),
                "legacyNavigationMaster": legacy_navigation,
                "backendControl": _environment_flag(
                    "ORINCAR_BACKEND_CONTROL_ENABLED", legacy_navigation
                ),
                "oneOffNavigation": _environment_flag(
                    "ORINCAR_ONE_OFF_NAVIGATION_ENABLED", legacy_navigation
                ),
                "patrol": _environment_flag(
                    "ORINCAR_PATROL_ENABLED", legacy_navigation
                ),
                "patrolLoop": _environment_flag(
                    "ORINCAR_PATROL_LOOP_ENABLED", legacy_navigation
                ),
            },
        }
        if release_manifest:
            manifest_path = Path(release_manifest).expanduser().resolve()
            metadata["releaseManifest"] = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
        _write_json(temporary / "metadata.json", metadata)
        commands = {
            "git-head": ["git", "rev-parse", "HEAD"],
            "git-status": ["git", "status", "--short", "--branch"],
            "ros-nodes": ["ros2", "node", "list"],
            "ros-topics": ["ros2", "topic", "list", "--types"],
            "ros-actions": ["ros2", "action", "list", "--types"],
            "cmd-vel-owners": ["ros2", "topic", "info", "/cmd_vel", "--verbose"],
            "map-owners": ["ros2", "topic", "info", "/map", "--verbose"],
            "ros-doctor": ["ros2", "doctor", "--report"],
            "processes": ["ps", "-eo", "pid,ppid,lstart,args"],
        }
        if mode:
            commands["commission-check"] = [
                "ros2", "run", "bbiyong_bringup", "commission_check",
                mode, "--json",
            ]
        command_results = {
            name: _run(arguments, timeout=12.0)
            for name, arguments in commands.items()
        }
        _write_json(temporary / "commands.json", command_results)
        logs_dir = temporary / "logs"
        for raw_path in log_files:
            source = Path(raw_path).expanduser().resolve()
            if not source.is_file():
                raise FileNotFoundError(f"log file not found: {source}")
            logs_dir.mkdir(exist_ok=True)
            content = source.read_bytes()[-2_000_000:].decode(
                "utf-8", errors="replace"
            )
            (logs_dir / source.name).write_text(redact_text(content), encoding="utf-8")
        _write_json(temporary / "sha256.json", {
            "schemaVersion": 1,
            "files": file_hashes(temporary),
        })
        os.replace(temporary, output)
    except Exception:
        # Keep a failed capture for diagnosis but never publish it as the final
        # evidence path. It contains only already-redacted command output.
        raise
    return output


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="capture redacted commissioning evidence")
    parser.add_argument("stage")
    parser.add_argument("output_dir")
    parser.add_argument("--mode", choices=("mapping", "scouting"))
    parser.add_argument("--log", action="append", default=[])
    parser.add_argument("--release-manifest")
    return parser.parse_args(argv)


def main(args=None):
    parsed = parse_args(args)
    try:
        output = collect_evidence(
            parsed.stage, parsed.output_dir, parsed.mode, parsed.log,
            parsed.release_manifest,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"collect-evidence: {exc}") from exc
    print(output)


if __name__ == "__main__":
    main(sys.argv[1:])
