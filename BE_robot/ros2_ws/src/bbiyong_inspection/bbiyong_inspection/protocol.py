"""Validation helpers for the package's versioned JSON ROS topics."""

from __future__ import annotations

import json
import math

from . import SCHEMA_VERSION


def decode_object(text, *, kind=None):
    try:
        value = json.loads(text)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("payload must be a JSON object")
    version = value.get("schemaVersion", SCHEMA_VERSION)
    if version != SCHEMA_VERSION:
        raise ValueError(f"unsupported schemaVersion: {version}")
    if kind is not None and value.get("kind") != kind:
        raise ValueError(f"expected kind={kind!r}")
    return value


def encode_object(kind, **values):
    return json.dumps(
        {"schemaVersion": SCHEMA_VERSION, "kind": kind, **values},
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def finite_number(value, name):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def integer(value, name, *, minimum=None):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if str(value).strip() not in {str(result), f"{result}.0"} and not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if minimum is not None and result < minimum:
        raise ValueError(f"{name} must be >= {minimum}")
    return result


def validate_xy(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return {
        "x": finite_number(value.get("x"), f"{name}.x"),
        "y": finite_number(value.get("y"), f"{name}.y"),
    }


def validate_viewpoint(value):
    result = validate_xy(value, "viewpoint")
    result["yaw"] = finite_number(value.get("yaw"), "viewpoint.yaw")
    return result


def validate_candidate(value):
    if not isinstance(value, dict):
        raise ValueError("candidate must be an object")
    candidate_id = str(value.get("candidateId", "")).strip()
    if not candidate_id or len(candidate_id) > 128:
        raise ValueError("candidateId is required and must be <= 128 characters")
    source = str(value.get("source", "")).upper()
    if source not in {"APRILTAG", "MANUAL"}:
        raise ValueError("source must be APRILTAG or MANUAL")
    result = {
        "candidateId": candidate_id,
        "source": source,
        "mapId": str(value.get("mapId", "unknown"))[:256],
        "target": validate_xy(value.get("target"), "target"),
        "viewpoint": validate_viewpoint(value.get("viewpoint")),
        "standOffM": finite_number(value.get("standOffM"), "standOffM"),
        "confidence": finite_number(value.get("confidence", 0.0), "confidence"),
        "createdAt": finite_number(value.get("createdAt", 0.0), "createdAt"),
    }
    if not 0.0 <= result["confidence"] <= 1.0:
        raise ValueError("confidence must be between 0 and 1")
    if not 0.05 <= result["standOffM"] <= 10.0:
        raise ValueError("standOffM is outside the safe range")
    if source == "APRILTAG":
        result["tagId"] = integer(value.get("tagId"), "tagId", minimum=0)
    else:
        result["tagId"] = None
    return result


def validate_point(value):
    candidate = validate_candidate({
        "candidateId": value.get("candidateId", value.get("id")),
        **value,
    })
    point_id = str(value.get("id", "")).strip()
    if not point_id or len(point_id) > 128:
        raise ValueError("point id is required and must be <= 128 characters")
    candidate.update({
        "id": point_id,
        "name": str(value.get("name", point_id))[:128],
        "enabled": bool(value.get("enabled", True)),
        "sequence": integer(value.get("sequence", 0), "sequence", minimum=0),
        "updatedAt": finite_number(value.get("updatedAt", 0.0), "updatedAt"),
    })
    return candidate
