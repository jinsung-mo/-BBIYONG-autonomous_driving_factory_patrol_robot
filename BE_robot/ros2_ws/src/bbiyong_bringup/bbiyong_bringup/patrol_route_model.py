"""Pure route validation and ordering helpers for waypoint patrol."""

from __future__ import annotations

import json
import math
from pathlib import Path


MAX_WAYPOINTS = 500


def _finite(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def validate_route(waypoints):
    if not isinstance(waypoints, list) or not waypoints:
        raise ValueError("waypoints must be a non-empty list")
    if len(waypoints) > MAX_WAYPOINTS:
        raise ValueError(f"route exceeds {MAX_WAYPOINTS} waypoints")
    normalized = []
    sequences = set()
    for index, raw in enumerate(waypoints):
        if not isinstance(raw, dict):
            raise ValueError(f"waypoints[{index}] must be an object")
        sequence_value = raw.get("seq", index)
        if isinstance(sequence_value, bool):
            raise ValueError(f"waypoints[{index}].seq must be an integer")
        try:
            sequence = int(sequence_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"waypoints[{index}].seq must be an integer") from exc
        if sequence < 0 or sequence in sequences:
            raise ValueError("waypoint seq values must be unique and non-negative")
        sequences.add(sequence)
        normalized.append({
            "seq": sequence,
            "x": _finite(raw.get("x"), f"waypoints[{index}].x"),
            "y": _finite(raw.get("y"), f"waypoints[{index}].y"),
            "yaw": _finite(
                0.0 if raw.get("yaw") is None else raw.get("yaw"),
                f"waypoints[{index}].yaw",
            ),
            "name": str(raw.get("name") or "")[:120],
        })
    return sorted(normalized, key=lambda point: point["seq"])


def load_route(path):
    route, _payload = load_route_document(path)
    return route


def load_route_document(path):
    payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    waypoints = payload.get("waypoints") if isinstance(payload, dict) else payload
    metadata = payload if isinstance(payload, dict) else {}
    return validate_route(waypoints), metadata


def yaw_quaternion(yaw):
    value = _finite(yaw, "yaw")
    return math.sin(value / 2.0), math.cos(value / 2.0)


def validate_goal(x, y, yaw=None):
    return {
        "x": _finite(x, "x"),
        "y": _finite(y, "y"),
        "yaw": _finite(0.0 if yaw is None else yaw, "yaw"),
    }


def resume_order(route_size, unfinished_index, loop_route):
    if route_size <= 0:
        return []
    start = max(0, min(int(unfinished_index), route_size - 1))
    order = list(range(start, route_size))
    if loop_route and start:
        order.extend(range(0, start))
    return order
