from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from cascade import CascadeConfig, fuse_cascade, should_run_verifier  # noqa: E402
from postprocessing import Detection  # noqa: E402


def detection(confidence: float, box=(0.0, 0.0, 10.0, 10.0), class_id=0) -> Detection:
    return Detection(class_id, ("smoke", "fire")[class_id], confidence, box)


class CascadeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = CascadeConfig(
            verify_low=0.15,
            verify_high=0.6,
            agreement_iou=0.3,
            verifier_only_confidence=0.5,
            verifier_interval=5,
        )

    def test_verifies_ambiguous_or_periodic_frames(self) -> None:
        self.assertTrue(should_run_verifier([detection(0.3)], 1, self.config))
        self.assertTrue(should_run_verifier([], 5, self.config))
        self.assertFalse(should_run_verifier([detection(0.8)], 1, self.config))

    def test_agreement_fuses_ambiguous_detection(self) -> None:
        fused = fuse_cascade([detection(0.3)], [detection(0.7)], self.config)
        self.assertEqual(len(fused), 1)
        self.assertAlmostEqual(fused[0].confidence, 0.79)

    def test_unsupported_ambiguous_detection_is_rejected(self) -> None:
        self.assertEqual(fuse_cascade([detection(0.3)], [], self.config), ())

    def test_keeps_high_primary_and_high_verifier_only_detection(self) -> None:
        output = fuse_cascade(
            [detection(0.8)],
            [detection(0.7, box=(20, 20, 30, 30), class_id=1)],
            self.config,
        )
        self.assertEqual({item.class_id for item in output}, {0, 1})


if __name__ == "__main__":
    unittest.main()
