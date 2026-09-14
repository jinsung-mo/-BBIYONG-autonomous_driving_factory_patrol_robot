from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from postprocessing import Detection, box_iou


@dataclass(frozen=True)
class CascadeConfig:
    verify_low: float = 0.15
    verify_high: float = 0.60
    primary_confidence: float = 0.25
    agreement_iou: float = 0.50
    verifier_only_confidence: float = 0.75
    final_nms_iou: float = 0.50
    verifier_interval: int = 5

    def validate(self) -> None:
        if not 0.0 <= self.verify_low <= self.verify_high <= 1.0:
            raise ValueError("Require 0 <= verify_low <= verify_high <= 1")
        if not self.verify_low <= self.primary_confidence <= self.verify_high:
            raise ValueError(
                "primary_confidence must be inside the verifier uncertainty band"
            )
        if not 0.0 <= self.agreement_iou <= 1.0:
            raise ValueError("agreement_iou must be in [0, 1]")
        if not 0.0 <= self.verifier_only_confidence <= 1.0:
            raise ValueError("verifier_only_confidence must be in [0, 1]")
        if not 0.0 < self.final_nms_iou <= 1.0:
            raise ValueError("final_nms_iou must be in (0, 1]")
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
    # The checkpoints share architecture and training data, so their scores are
    # correlated. A geometric mean rewards agreement without treating the two
    # scores as independent probabilities and inflating confidence.
    confidence = math.sqrt(primary.confidence * verifier.confidence)
    return Detection(primary.class_id, primary.class_name, confidence, box)


def _best_match(
    proposal: Detection,
    verifier_items: list[Detection],
    unmatched_verifier: set[int],
    agreement_iou: float,
) -> int | None:
    best_index = None
    best_overlap = agreement_iou
    for verifier_index in unmatched_verifier:
        candidate = verifier_items[verifier_index]
        if candidate.class_id != proposal.class_id:
            continue
        overlap = box_iou(proposal.xyxy, candidate.xyxy)
        if overlap >= best_overlap:
            best_index = verifier_index
            best_overlap = overlap
    return best_index


def _class_aware_nms(
    detections: Iterable[Detection], iou_threshold: float
) -> tuple[Detection, ...]:
    kept: list[Detection] = []
    for candidate in sorted(detections, key=lambda item: item.confidence, reverse=True):
        duplicate = any(
            existing.class_id == candidate.class_id
            and box_iou(existing.xyxy, candidate.xyxy) >= iou_threshold
            for existing in kept
        )
        if not duplicate:
            kept.append(candidate)
    return tuple(kept)


def fuse_cascade(
    primary: Iterable[Detection],
    verifier: Iterable[Detection] | None,
    config: CascadeConfig,
) -> tuple[Detection, ...]:
    """Confirm ambiguous proposals and add only unmatched, strong verifier boxes."""
    config.validate()
    primary_items = sorted(primary, key=lambda item: item.confidence, reverse=True)
    if verifier is None:
        return _class_aware_nms(
            (
                item
                for item in primary_items
                if item.confidence >= config.primary_confidence
            ),
            config.final_nms_iou,
        )

    verifier_items = sorted(verifier, key=lambda item: item.confidence, reverse=True)
    unmatched_verifier = set(range(len(verifier_items)))
    accepted: list[Detection] = []

    for proposal in primary_items:
        if proposal.confidence < config.verify_low:
            continue

        best_index = _best_match(
            proposal,
            verifier_items,
            unmatched_verifier,
            config.agreement_iou,
        )

        # A normal primary detection survives independently of the verifier.
        # Consume any overlapping verifier box so it cannot be re-added below.
        if proposal.confidence >= config.primary_confidence:
            accepted.append(proposal)
            if best_index is not None:
                unmatched_verifier.remove(best_index)
            continue

        # Only lower-confidence primary proposals require model agreement.
        if best_index is not None:
            accepted.append(_fuse(proposal, verifier_items[best_index]))
            unmatched_verifier.remove(best_index)

    for verifier_index in unmatched_verifier:
        candidate = verifier_items[verifier_index]
        if candidate.confidence >= config.verifier_only_confidence:
            accepted.append(candidate)

    return _class_aware_nms(accepted, config.final_nms_iou)
