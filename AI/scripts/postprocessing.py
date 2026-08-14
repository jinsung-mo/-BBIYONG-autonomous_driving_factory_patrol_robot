from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class Detection:
    class_id: int
    class_name: str
    confidence: float
    xyxy: tuple[float, float, float, float]


@dataclass(frozen=True)
class ClassPolicy:
    threshold: float
    hold_threshold: float


@dataclass(frozen=True)
class TemporalPolicy:
    window: int = 5
    min_hits: int = 3
    clear_after: int = 3
    spatial_iou: float = 0.0


@dataclass(frozen=True)
class PostprocessConfig:
    classes: dict[int, ClassPolicy]
    temporal: TemporalPolicy = field(default_factory=TemporalPolicy)
    candidate_confidence: float = 0.01
    nms_iou: float = 0.7
    max_det: int = 300
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "PostprocessConfig":
        classes = {
            int(class_id): ClassPolicy(
                threshold=float(policy["threshold"]),
                hold_threshold=float(policy.get("hold_threshold", policy["threshold"])),
            )
            for class_id, policy in value["classes"].items()
        }
        temporal = TemporalPolicy(**value.get("temporal", {}))
        config = cls(
            classes=classes,
            temporal=temporal,
            candidate_confidence=float(value.get("candidate_confidence", 0.01)),
            nms_iou=float(value.get("nms_iou", 0.7)),
            max_det=int(value.get("max_det", 300)),
            metadata=dict(value.get("metadata", {})),
        )
        config.validate()
        return config

    @classmethod
    def load(cls, path: Path) -> "PostprocessConfig":
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def validate(self) -> None:
        if not self.classes:
            raise ValueError("At least one class policy is required")
        for class_id, policy in self.classes.items():
            if class_id < 0:
                raise ValueError("Class IDs must be non-negative")
            if not 0.0 <= policy.hold_threshold <= policy.threshold <= 1.0:
                raise ValueError("Require 0 <= hold_threshold <= threshold <= 1")
        if not 0.0 <= self.candidate_confidence <= min(
            policy.hold_threshold for policy in self.classes.values()
        ):
            raise ValueError("candidate_confidence must not exceed a class hold threshold")
        if not 0.0 < self.nms_iou <= 1.0 or self.max_det < 1:
            raise ValueError("nms_iou must be in (0, 1] and max_det must be positive")
        if not 1 <= self.temporal.min_hits <= self.temporal.window:
            raise ValueError("Require 1 <= temporal min_hits <= window")
        if self.temporal.clear_after < 1 or not 0.0 <= self.temporal.spatial_iou <= 1.0:
            raise ValueError("clear_after must be positive and spatial_iou in [0, 1]")


@dataclass(frozen=True)
class FrameDecision:
    detections: tuple[Detection, ...]
    active_classes: frozenset[int]
    activated_classes: frozenset[int]
    cleared_classes: frozenset[int]


@dataclass
class _TemporalState:
    history: deque[bool]
    active: bool = False
    misses: int = 0
    last_box: tuple[float, float, float, float] | None = None


def box_iou(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
) -> float:
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[2], right[2])
    y2 = min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union > 0.0 else 0.0


class FireSmokePostprocessor:
    """Class thresholds plus M-of-N temporal confirmation and hysteresis."""

    def __init__(self, config: PostprocessConfig):
        config.validate()
        self.config = config
        self._states = {
            class_id: _TemporalState(deque(maxlen=config.temporal.window))
            for class_id in config.classes
        }

    def reset(self) -> None:
        for state in self._states.values():
            state.history.clear()
            state.active = False
            state.misses = 0
            state.last_box = None

    def process(self, detections: Iterable[Detection]) -> FrameDecision:
        by_class: dict[int, list[Detection]] = {class_id: [] for class_id in self.config.classes}
        for detection in detections:
            if detection.class_id in by_class:
                by_class[detection.class_id].append(detection)

        accepted: list[Detection] = []
        activated: set[int] = set()
        cleared: set[int] = set()
        policy = self.config.temporal

        for class_id, class_policy in self.config.classes.items():
            state = self._states[class_id]
            threshold = class_policy.hold_threshold if state.active else class_policy.threshold
            candidates = [item for item in by_class[class_id] if item.confidence >= threshold]
            candidates.sort(key=lambda item: item.confidence, reverse=True)
            best = candidates[0] if candidates else None

            if best is not None and state.last_box is not None and policy.spatial_iou > 0.0:
                spatial = [
                    item for item in candidates if box_iou(item.xyxy, state.last_box) >= policy.spatial_iou
                ]
                best = spatial[0] if spatial else None
                if best is None and not state.active:
                    state.history.clear()

            hit = best is not None
            state.history.append(hit)
            if hit:
                accepted.extend(candidates)
                state.last_box = best.xyxy
                state.misses = 0
            else:
                state.misses += 1

            if not state.active and sum(state.history) >= policy.min_hits:
                state.active = True
                activated.add(class_id)
            elif state.active and state.misses >= policy.clear_after:
                state.active = False
                state.history.clear()
                state.last_box = None
                cleared.add(class_id)

        active = frozenset(class_id for class_id, state in self._states.items() if state.active)
        return FrameDecision(
            detections=tuple(accepted),
            active_classes=active,
            activated_classes=frozenset(activated),
            cleared_classes=frozenset(cleared),
        )


def detections_from_result(result: Any, names: list[str]) -> list[Detection]:
    if result.boxes is None:
        return []
    boxes = result.boxes.xyxy.detach().cpu().tolist()
    confidences = result.boxes.conf.detach().cpu().tolist()
    classes = result.boxes.cls.detach().cpu().tolist()
    return [
        Detection(
            class_id=int(class_id),
            class_name=names[int(class_id)],
            confidence=float(confidence),
            xyxy=tuple(float(value) for value in box),
        )
        for box, confidence, class_id in zip(boxes, confidences, classes, strict=True)
    ]
