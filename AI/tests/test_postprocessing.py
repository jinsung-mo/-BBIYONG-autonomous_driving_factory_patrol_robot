from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from postprocessing import (  # noqa: E402
    ClassPolicy,
    Detection,
    FireSmokePostprocessor,
    PostprocessConfig,
    TemporalPolicy,
    box_iou,
)


def detection(class_id: int, confidence: float, box=(0.0, 0.0, 10.0, 10.0)) -> Detection:
    return Detection(class_id, ("smoke", "fire")[class_id], confidence, box)


class PostprocessingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = PostprocessConfig(
            classes={
                0: ClassPolicy(threshold=0.4, hold_threshold=0.25),
                1: ClassPolicy(threshold=0.5, hold_threshold=0.3),
            },
            temporal=TemporalPolicy(window=3, min_hits=2, clear_after=2),
            candidate_confidence=0.1,
        )

    def test_iou(self) -> None:
        self.assertEqual(box_iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertEqual(box_iou((0, 0, 1, 1), (2, 2, 3, 3)), 0.0)

    def test_temporal_confirmation_rejects_single_frame_false_positive(self) -> None:
        pipeline = FireSmokePostprocessor(self.config)
        first = pipeline.process([detection(0, 0.8)])
        second = pipeline.process([])
        self.assertFalse(first.active_classes)
        self.assertFalse(second.active_classes)

    def test_activation_hysteresis_and_clear(self) -> None:
        pipeline = FireSmokePostprocessor(self.config)
        pipeline.process([detection(0, 0.8)])
        activated = pipeline.process([detection(0, 0.7)])
        held = pipeline.process([detection(0, 0.3)])
        self.assertEqual(activated.activated_classes, frozenset({0}))
        self.assertEqual(held.active_classes, frozenset({0}))
        pipeline.process([])
        cleared = pipeline.process([])
        self.assertEqual(cleared.cleared_classes, frozenset({0}))

    def test_rejects_invalid_threshold_order(self) -> None:
        with self.assertRaisesRegex(ValueError, "hold_threshold"):
            PostprocessConfig(
                classes={0: ClassPolicy(threshold=0.3, hold_threshold=0.4)}
            ).validate()


if __name__ == "__main__":
    unittest.main()
