#!/usr/bin/env python3
"""Validate, confirm, persist, and publish inspection points."""

from __future__ import annotations

import json
import os
from pathlib import Path
import time
import uuid

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import String

from . import SCHEMA_VERSION
from .protocol import (
    decode_object,
    encode_object,
    integer,
    validate_candidate,
    validate_point,
)


def atomic_write_json(path, payload):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + f".tmp-{os.getpid()}")
    try:
        temporary.write_text(
            json.dumps(payload, allow_nan=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


class InspectionPointManager(Node):
    def __init__(self):
        super().__init__("bbiyong_inspection_point_manager")
        self.declare_parameter("candidate_topic", "/inspection/candidates")
        self.declare_parameter("command_topic", "/inspection/point_command")
        self.declare_parameter("points_topic", "/inspection/points")
        self.declare_parameter("pending_topic", "/inspection/pending_candidates")
        self.declare_parameter("events_topic", "/inspection/point_events")
        self.declare_parameter(
            "storage_file", "~/.local/state/bbiyong/inspection_points.json"
        )
        self.declare_parameter("map_id", "active-map")
        self.declare_parameter("auto_confirm_apriltag", False)
        self.declare_parameter("auto_confirm_manual", False)
        self.declare_parameter("max_points", 500)
        self.declare_parameter("max_pending", 100)

        self.storage_file = Path(
            str(self.get_parameter("storage_file").value)
        ).expanduser()
        self.map_id = str(self.get_parameter("map_id").value)
        self.auto_confirm_apriltag = bool(
            self.get_parameter("auto_confirm_apriltag").value
        )
        self.auto_confirm_manual = bool(
            self.get_parameter("auto_confirm_manual").value
        )
        self.max_points = int(self.get_parameter("max_points").value)
        self.max_pending = int(self.get_parameter("max_pending").value)
        if self.max_points < 1 or self.max_pending < 1:
            raise ValueError("max_points and max_pending must be positive")

        self.points = {}
        self.pending = {}
        self._load()

        latched = QoSProfile(
            depth=1,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            reliability=ReliabilityPolicy.RELIABLE,
        )
        self.points_publisher = self.create_publisher(
            String, str(self.get_parameter("points_topic").value), latched
        )
        self.pending_publisher = self.create_publisher(
            String, str(self.get_parameter("pending_topic").value), latched
        )
        self.event_publisher = self.create_publisher(
            String, str(self.get_parameter("events_topic").value), 10
        )
        self.create_subscription(
            String,
            str(self.get_parameter("candidate_topic").value),
            self._on_candidate,
            10,
        )
        self.create_subscription(
            String,
            str(self.get_parameter("command_topic").value),
            self._on_command,
            10,
        )
        self.create_timer(0.2, self._publish_initial)
        self.initial_published = False

    def _load(self):
        if not self.storage_file.exists():
            return
        try:
            document = json.loads(self.storage_file.read_text(encoding="utf-8"))
            if not isinstance(document, dict):
                raise ValueError("storage document must be an object")
            if document.get("schemaVersion") != SCHEMA_VERSION:
                raise ValueError("unsupported storage schema")
            stored_map_id = str(document.get("mapId", ""))
            if stored_map_id != self.map_id:
                self.get_logger().warning(
                    f"ignored points for map {stored_map_id!r}; active map is {self.map_id!r}"
                )
                return
            raw_points = document.get("points", [])
            if not isinstance(raw_points, list):
                raise ValueError("stored points must be a list")
            for raw in raw_points[: self.max_points]:
                point = validate_point(raw)
                if point["mapId"] != self.map_id:
                    raise ValueError(f"point {point['id']} belongs to a different map")
                if point["id"] in self.points:
                    raise ValueError(f"duplicate point id: {point['id']}")
                self.points[point["id"]] = point
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            self.points.clear()
            self.get_logger().error(
                f"could not load inspection points; starting empty without modifying file: {exc}"
            )

    def _save(self):
        ordered = self._ordered_points()
        atomic_write_json(self.storage_file, {
            "schemaVersion": SCHEMA_VERSION,
            "mapId": self.map_id,
            "updatedAt": time.time(),
            "points": ordered,
        })

    def _ordered_points(self):
        return sorted(
            self.points.values(), key=lambda point: (point["sequence"], point["id"])
        )

    def _publish_initial(self):
        if self.initial_published:
            return
        self.initial_published = True
        self._publish_all()

    def _publish_all(self):
        self.points_publisher.publish(String(data=encode_object(
            "inspection_points", mapId=self.map_id, points=self._ordered_points()
        )))
        self.pending_publisher.publish(String(data=encode_object(
            "inspection_candidates",
            mapId=self.map_id,
            candidates=sorted(
                self.pending.values(), key=lambda item: item["createdAt"]
            ),
        )))

    def _event(self, event, *, ok=True, reason="", **values):
        self.event_publisher.publish(String(data=encode_object(
            "inspection_point_event",
            event=event,
            ok=bool(ok),
            reason=reason,
            **values,
        )))

    def _on_candidate(self, message):
        try:
            payload = decode_object(message.data, kind="inspection_candidate")
            candidate = validate_candidate(payload.get("candidate"))
            if candidate["mapId"] != self.map_id:
                raise ValueError("candidate belongs to a different map")
            candidate_id = candidate["candidateId"]
            if candidate_id not in self.pending and len(self.pending) >= self.max_pending:
                oldest = min(self.pending, key=lambda key: self.pending[key]["createdAt"])
                del self.pending[oldest]
            self.pending[candidate_id] = candidate
            auto_confirm = (
                candidate["source"] == "APRILTAG" and self.auto_confirm_apriltag
            ) or (candidate["source"] == "MANUAL" and self.auto_confirm_manual)
            if auto_confirm:
                self._confirm(candidate_id, None)
            else:
                self._publish_all()
                self._event("CANDIDATE_RECEIVED", candidateId=candidate_id)
        except ValueError as exc:
            self.get_logger().warning(f"ignored invalid inspection candidate: {exc}")

    def _find_tag_point(self, candidate):
        if candidate["source"] != "APRILTAG":
            return None
        for point in self.points.values():
            if (
                point["source"] == "APRILTAG"
                and point.get("tagId") == candidate.get("tagId")
                and point["mapId"] == candidate["mapId"]
            ):
                return point
        return None

    def _confirm(self, candidate_id, name):
        candidate = self.pending.get(candidate_id)
        if candidate is None:
            raise ValueError(f"unknown candidateId: {candidate_id}")
        existing = self._find_tag_point(candidate)
        if existing is None and len(self.points) >= self.max_points:
            raise ValueError("maximum inspection point count reached")
        now = time.time()
        if existing is None:
            point_id = uuid.uuid4().hex
            sequence = max(
                (point["sequence"] for point in self.points.values()), default=-1
            ) + 1
            default_name = (
                f"AprilTag {candidate['tagId']}"
                if candidate["source"] == "APRILTAG"
                else f"Inspection {sequence + 1}"
            )
        else:
            point_id = existing["id"]
            sequence = existing["sequence"]
            default_name = existing["name"]
        point = validate_point({
            **candidate,
            "id": point_id,
            "name": str(name).strip()[:128] if name else default_name,
            "sequence": sequence,
            "enabled": True if existing is None else existing["enabled"],
            "updatedAt": now,
        })
        self.points[point_id] = point
        del self.pending[candidate_id]
        self._save()
        self._publish_all()
        self._event("POINT_CONFIRMED", pointId=point_id, candidateId=candidate_id)

    def _delete(self, point_id):
        if point_id not in self.points:
            raise ValueError(f"unknown pointId: {point_id}")
        del self.points[point_id]
        for sequence, point in enumerate(self._ordered_points()):
            point["sequence"] = sequence
        self._save()
        self._publish_all()
        self._event("POINT_DELETED", pointId=point_id)

    def _update(self, payload):
        point_id = str(payload.get("pointId", ""))
        point = self.points.get(point_id)
        if point is None:
            raise ValueError(f"unknown pointId: {point_id}")
        updated = dict(point)
        if "name" in payload:
            updated["name"] = str(payload["name"]).strip()[:128]
        if "enabled" in payload:
            if not isinstance(payload["enabled"], bool):
                raise ValueError("enabled must be a boolean")
            updated["enabled"] = payload["enabled"]
        if "sequence" in payload:
            updated["sequence"] = integer(
                payload["sequence"], "sequence", minimum=0
            )
        updated["updatedAt"] = time.time()
        self.points[point_id] = validate_point(updated)
        self._save()
        self._publish_all()
        self._event("POINT_UPDATED", pointId=point_id)

    def _reject_candidate(self, candidate_id):
        if candidate_id not in self.pending:
            raise ValueError(f"unknown candidateId: {candidate_id}")
        del self.pending[candidate_id]
        self._publish_all()
        self._event("CANDIDATE_REJECTED", candidateId=candidate_id)

    def _on_command(self, message):
        command_name = "UNKNOWN"
        try:
            payload = decode_object(message.data, kind="inspection_point_command")
            command_name = str(payload.get("command", "")).upper()
            if command_name == "CONFIRM":
                self._confirm(str(payload.get("candidateId", "")), payload.get("name"))
            elif command_name == "REJECT":
                self._reject_candidate(str(payload.get("candidateId", "")))
            elif command_name == "DELETE":
                self._delete(str(payload.get("pointId", "")))
            elif command_name == "UPDATE":
                self._update(payload)
            elif command_name == "PUBLISH":
                self._publish_all()
            else:
                raise ValueError(f"unsupported command: {command_name}")
        except (OSError, ValueError) as exc:
            self.get_logger().warning(f"inspection point command failed: {exc}")
            self._event(command_name, ok=False, reason=str(exc))


def main(args=None):
    rclpy.init(args=args)
    node = InspectionPointManager()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    main()
