from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from postprocessing import Detection, box_iou


@dataclass(frozen=True)
class CascadeConfig:
    verify_low: float = 0.15
    verify_high: float = 0.60
    agreement_iou: float = 0.30
    verifier_only_confidence: float = 0.50
    verifier_interval: int = 5

    def validate(self) -> None:
        if not 0.0 <= self.verify_low <= self.verify_high <= 1.0:
            raise ValueError("Require 0 <= verify_low <= verify_high <= 1")
        if not 0.0 <= self.agreement_iou <= 1.0:
            raise ValueError("agreement_iou must be in [0, 1]")
        if not 0.0 <= self.verifier_only_confidence <= 1.0:
            raise ValueError("verifier_only_confidence must be in [0, 1]")
        if self.verifier_interval < 1:
            raise ValueError("verifier_interval must be positive")


@dataclass(frozen=True)
class CascadeDecision:
    detections: tuple[Detection, ...]
    verifier_required: bool


def should_run_verifier(
    primary: Iterable[Detection], frame_index: int, config: CascadeConfig
) -> bool:
    config.validate()
    ambiguous = any(
        config.verify_low <= detection.confidence < config.verify_high
        for detection in primary
    )
    return ambiguous or frame_index % config.verifier_interval == 0


def _fuse(primary: Detection, verifier: Detection) -> Detection:
    total = max(primary.confidence + verifier.confidence, 1e-12)
    box = tuple(
        (left * primary.confidence + right * verifier.confidence) / total
        for left, right in zip(primary.xyxy, verifier.xyxy, strict=True)
    )
    # Independent-evidence union rewards agreement without exceeding one.
    confidence = 1.0 - (1.0 - primary.confidence) * (1.0 - verifier.confidence)
    return Detection(primary.class_id, primary.class_name, confidence, box)


def fuse_cascade(
    primary: Iterable[Detection],
    verifier: Iterable[Detection] | None,
    config: CascadeConfig,
) -> tuple[Detection, ...]:
    """Fuse two-model agreement and suppress unsupported ambiguous proposals."""
    config.validate()
    primary_items = sorted(primary, key=lambda item: item.confidence, reverse=True)
    if verifier is None:
        return tuple(item for item in primary_items if item.confidence >= config.verify_high)

    verifier_items = sorted(verifier, key=lambda item: item.confidence, reverse=True)
    unmatched_verifier = set(range(len(verifier_items)))
    accepted: list[Detection] = []

    for proposal in primary_items:
        if proposal.confidence >= config.verify_high:
            accepted.append(proposal)
            continue
        if proposal.confidence < config.verify_low:
            continue

        best_index = None
        best_overlap = config.agreement_iou
        for verifier_index in unmatched_verifier:
            candidate = verifier_items[verifier_index]
            if candidate.class_id != proposal.class_id:
                continue
            overlap = box_iou(proposal.xyxy, candidate.xyxy)
            if overlap >= best_overlap:
                best_index = verifier_index
                best_overlap = overlap
        if best_index is not None:
            accepted.append(_fuse(proposal, verifier_items[best_index]))
            unmatched_verifier.remove(best_index)

    for verifier_index in unmatched_verifier:
        candidate = verifier_items[verifier_index]
        if candidate.confidence >= config.verifier_only_confidence:
            accepted.append(candidate)

    return tuple(sorted(accepted, key=lambda item: item.confidence, reverse=True))
