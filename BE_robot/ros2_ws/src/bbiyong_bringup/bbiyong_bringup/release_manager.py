"""Immutable, hash-verified robot release staging and symlink rollback."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid


RELEASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
RELEASE_ITEMS = (
    "orin_dashboard",
    "ros2_ws/dependencies.repos",
    "ros2_ws/docs",
    "ros2_ws/README.md",
    "ros2_ws/scripts",
    "ros2_ws/src",
)
EXCLUDED_PARTS = {".git", "__pycache__", "build", "install", "log"}
SECRET_FILE = re.compile(
    r"(?i)(^\.env(?:\.|$)|jira_config|credential|password|passwd|token|secret|api[_-]?key)"
)


def _safe_release_id(value):
    if not RELEASE_ID.fullmatch(value):
        raise ValueError("release id contains unsupported characters")
    return value


def _hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _included_files(source):
    for item in RELEASE_ITEMS:
        root = source / item
        if not root.exists():
            raise FileNotFoundError(f"required release path missing: {root}")
        candidates = [root] if root.is_file() else root.rglob("*")
        for path in candidates:
            if not path.is_file():
                continue
            relative = path.relative_to(source)
            if path.is_symlink():
                raise ValueError(f"release source must not contain symlinks: {relative}")
            if any(part in EXCLUDED_PARTS for part in relative.parts):
                continue
            if SECRET_FILE.search(path.name) or path.suffix == ".pyc":
                continue
            yield relative, path


def _manifest(root):
    files = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative == "release-manifest.json":
            continue
        if any(part in EXCLUDED_PARTS for part in path.relative_to(root).parts):
            continue
        if path.suffix == ".pyc":
            continue
        files[relative] = {"sha256": _hash(path), "size": path.stat().st_size}
    return {"schemaVersion": 1, "files": files}


def _source_commit(source):
    try:
        completed = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "HEAD"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=3.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and re.fullmatch(r"[0-9a-f]{40,64}", value) else None


def verify_release(release):
    release = Path(release).expanduser().resolve()
    manifest_file = release / "release-manifest.json"
    payload = json.loads(manifest_file.read_text(encoding="utf-8"))
    expected = payload.get("files")
    actual = _manifest(release)["files"]
    if expected != actual:
        missing = sorted(set(expected or {}) - set(actual))
        extra = sorted(set(actual) - set(expected or {}))
        changed = sorted(
            key for key in set(expected or {}) & set(actual)
            if expected[key] != actual[key]
        )
        raise ValueError(
            f"release hash verification failed: missing={missing}, "
            f"extra={extra}, changed={changed}"
        )
    return payload


def stage_release(source, release_root, release_id):
    source = Path(source).expanduser().resolve()
    release_root = Path(release_root).expanduser().resolve()
    release_id = _safe_release_id(release_id)
    if not source.is_dir():
        raise FileNotFoundError(f"release source not found: {source}")
    if (
        release_root == source
        or source in release_root.parents
        or release_root in source.parents
    ):
        raise ValueError("release root and source must not contain one another")
    releases = release_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target = releases / release_id
    if target.exists():
        raise FileExistsError(f"immutable release already exists: {target}")
    temporary = releases / f".{release_id}.tmp-{uuid.uuid4().hex}"
    temporary.mkdir()
    try:
        copied = 0
        for relative, path in _included_files(source):
            destination = temporary / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
            copied += 1
        if copied == 0:
            raise ValueError("release contains no files")
        payload = _manifest(temporary)
        payload.update({
            "releaseId": release_id,
            "sourceCommit": _source_commit(source),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        })
        (temporary / "release-manifest.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
        )
        verify_release(temporary)
        os.replace(temporary, target)
    except Exception:
        # A failed hidden staging directory is intentionally retained for
        # inspection; no active release link is changed.
        raise
    return target


def _assert_operator_guards(confirm_stopped, confirm_independent_stop, operator):
    if not confirm_stopped:
        raise ValueError("refusing activation: --confirm-stopped is required")
    if not confirm_independent_stop:
        raise ValueError(
            "refusing activation: --confirm-independent-stop is required"
        )
    if not str(operator or "").strip():
        raise ValueError("refusing activation: --operator is required")


def _atomic_symlink(link, target):
    temporary = link.with_name(f".{link.name}.next-{uuid.uuid4().hex}")
    os.symlink(str(target), str(temporary), target_is_directory=True)
    os.replace(temporary, link)


def activate_release(
    release_root, release_id, confirm_stopped=False,
    confirm_independent_stop=False, operator="",
):
    _assert_operator_guards(confirm_stopped, confirm_independent_stop, operator)
    release_root = Path(release_root).expanduser().resolve()
    target = release_root / "releases" / _safe_release_id(release_id)
    verify_release(target)
    current = release_root / "current"
    previous = release_root / "previous"
    if previous.exists() and not previous.is_symlink():
        raise ValueError("previous exists but is not a managed symlink")
    old_target = current.resolve() if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        raise ValueError("current exists but is not a managed symlink")
    if old_target and old_target != target:
        _atomic_symlink(previous, old_target)
    _atomic_symlink(current, target)
    state = {
        "schemaVersion": 1,
        "current": target.name,
        "previous": old_target.name if old_target and old_target != target else None,
        "operator": operator.strip(),
        "activatedAt": datetime.now(timezone.utc).isoformat(),
    }
    temporary = release_root / ".deployment-state.json.tmp"
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, release_root / "deployment-state.json")
    return target


def rollback_release(
    release_root, confirm_stopped=False,
    confirm_independent_stop=False, operator="",
):
    _assert_operator_guards(confirm_stopped, confirm_independent_stop, operator)
    release_root = Path(release_root).expanduser().resolve()
    previous = release_root / "previous"
    current = release_root / "current"
    if current.exists() and not current.is_symlink():
        raise ValueError("current exists but is not a managed symlink")
    if not previous.is_symlink():
        raise ValueError("no managed previous release is available")
    target = previous.resolve()
    verify_release(target)
    old_current = current.resolve() if current.is_symlink() else None
    _atomic_symlink(current, target)
    if old_current and old_current != target:
        _atomic_symlink(previous, old_current)
    return target


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="guarded immutable robot releases")
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("stage")
    stage.add_argument("source")
    stage.add_argument("release_root")
    stage.add_argument("release_id")
    verify = commands.add_parser("verify")
    verify.add_argument("release")
    for name in ("activate", "rollback"):
        command = commands.add_parser(name)
        command.add_argument("release_root")
        if name == "activate":
            command.add_argument("release_id")
        command.add_argument("--confirm-stopped", action="store_true")
        command.add_argument("--confirm-independent-stop", action="store_true")
        command.add_argument("--operator", required=True)
    return parser.parse_args(argv)


def main(args=None):
    parsed = parse_args(args)
    try:
        if parsed.command == "stage":
            result = stage_release(parsed.source, parsed.release_root, parsed.release_id)
        elif parsed.command == "verify":
            result = verify_release(parsed.release)
        elif parsed.command == "activate":
            result = activate_release(
                parsed.release_root, parsed.release_id,
                parsed.confirm_stopped, parsed.confirm_independent_stop,
                parsed.operator,
            )
        else:
            result = rollback_release(
                parsed.release_root, parsed.confirm_stopped,
                parsed.confirm_independent_stop, parsed.operator,
            )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"release-manager: {exc}") from exc
    print(json.dumps(result, indent=2, sort_keys=True) if isinstance(result, dict) else result)


if __name__ == "__main__":
    main(sys.argv[1:])
