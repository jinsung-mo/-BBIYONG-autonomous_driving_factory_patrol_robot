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
            primary_confidence=0.25,
            agreement_iou=0.5,
            verifier_only_confidence=0.75,
            final_nms_iou=0.5,
            verifier_interval=5,
        )

    def test_verifies_ambiguous_or_periodic_frames(self) -> None:
        self.assertTrue(should_run_verifier([detection(0.3)], 1, self.config))
        self.assertTrue(should_run_verifier([], 5, self.config))
        self.assertFalse(should_run_verifier([detection(0.8)], 1, self.config))

    def test_agreement_fuses_ambiguous_detection(self) -> None:
        fused = fuse_cascade([detection(0.2)], [detection(0.8)], self.config)
        self.assertEqual(len(fused), 1)
        self.assertAlmostEqual(fused[0].confidence, 0.4)

    def test_unsupported_ambiguous_detection_is_rejected(self) -> None:
        self.assertEqual(fuse_cascade([detection(0.2)], [], self.config), ())

    def test_keeps_normal_primary_when_verifier_does_not_run(self) -> None:
        output = fuse_cascade([detection(0.3)], None, self.config)
        self.assertEqual(output, (detection(0.3),))

    def test_rejects_subthreshold_primary_when_verifier_does_not_run(self) -> None:
        self.assertEqual(fuse_cascade([detection(0.2)], None, self.config), ())

    def test_consumes_verifier_duplicate_of_high_primary(self) -> None:
        output = fuse_cascade(
            [detection(0.8)],
            [detection(0.9, box=(1, 1, 9, 9))],
            self.config,
        )
        self.assertEqual(output, (detection(0.8),))

    def test_keeps_high_primary_and_high_verifier_only_detection(self) -> None:
        output = fuse_cascade(
            [detection(0.8)],
            [detection(0.8, box=(20, 20, 30, 30), class_id=1)],
            self.config,
        )
        self.assertEqual({item.class_id for item in output}, {0, 1})

    def test_final_nms_suppresses_same_class_verifier_duplicates(self) -> None:
        output = fuse_cascade(
            [],
            [
                detection(0.9),
                detection(0.8, box=(1, 1, 9, 9)),
            ],
            self.config,
        )
        self.assertEqual(output, (detection(0.9),))

    def test_rejects_primary_threshold_outside_uncertainty_band(self) -> None:
        with self.assertRaisesRegex(ValueError, "primary_confidence"):
            CascadeConfig(primary_confidence=0.8).validate()


if __name__ == "__main__":
    unittest.main()
