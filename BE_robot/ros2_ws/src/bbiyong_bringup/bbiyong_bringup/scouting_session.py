"""Pure persistence helpers for a saved-map scouting session."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import time


def atomic_write_json(path, payload):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    os.replace(temporary, target)


def read_ready_session(path, max_age_sec=3.0):
    try:
        payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    session_id = payload.get("sessionId")
    map_file = payload.get("mapFile")
    try:
        age = time.time() - float(payload["updatedAt"])
    except (KeyError, TypeError, ValueError):
        return None
    if (
        payload.get("ready") is not True
        or not session_id
        or not map_file
        or not math.isfinite(age)
        or age < -1.0
        or age > max_age_sec
    ):
        return None
    return payload


def route_matches_session(route_payload, session_payload):
    return bool(
        session_payload
        and route_payload.get("scoutingSessionId") == session_payload.get("sessionId")
    )
