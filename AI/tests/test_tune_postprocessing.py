from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from postprocessing import Detection  # noqa: E402
from tune_postprocessing import (  # noqa: E402
    GroundTruth,
    ImageRecord,
    choose_threshold,
    match_counts,
    score_counts,
    threshold_values,
)


class TunePostprocessingTests(unittest.TestCase):
    def test_greedy_matching_counts_duplicates_as_false_positives(self) -> None:
        record = ImageRecord(
            predictions=(
                Detection(0, "smoke", 0.9, (0, 0, 10, 10)),
                Detection(0, "smoke", 0.8, (0, 0, 10, 10)),
            ),
            targets=(GroundTruth(0, (0, 0, 10, 10)),),
        )
        self.assertEqual(match_counts([record], 0, 0.5, 0.5), (1, 1, 0))

    def test_f_beta_and_constraint_selection(self) -> None:
        rows = [
            {"threshold": 0.2, "precision": 0.6, "recall": 0.9, "f_beta": 0.8},
            {"threshold": 0.4, "precision": 0.8, "recall": 0.7, "f_beta": 0.75},
        ]
        best, constraints_met = choose_threshold(rows, min_precision=0.75, min_recall=0.0)
        self.assertTrue(constraints_met)
        self.assertEqual(best["threshold"], 0.4)
        score = score_counts(8, 2, 2, beta=1.0)
        self.assertAlmostEqual(score["f_beta"], 0.8)

    def test_threshold_values_include_endpoints(self) -> None:
        self.assertEqual(threshold_values(0.1, 0.3, 0.1), [0.1, 0.2, 0.3])


if __name__ == "__main__":
    unittest.main()
