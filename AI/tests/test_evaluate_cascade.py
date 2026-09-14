from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from evaluate_cascade import Prediction, Target, evaluate_predictions  # noqa: E402


BOX = (0.0, 0.0, 10.0, 10.0)


class CascadeEvaluationTests(unittest.TestCase):
    def test_perfect_predictions_have_perfect_metrics(self) -> None:
        targets = [Target(0, 0, BOX), Target(1, 1, BOX)]
        predictions = [
            Prediction(0, 0, 0.9, BOX),
            Prediction(1, 1, 0.8, BOX),
        ]

        report = evaluate_predictions(predictions, targets, ["smoke", "fire"], 0.25)

        self.assertEqual(report["aggregate"]["precision"], 1.0)
        self.assertEqual(report["aggregate"]["recall"], 1.0)
        self.assertEqual(report["aggregate"]["map50"], 1.0)
        self.assertEqual(report["aggregate"]["map50_95"], 1.0)

    def test_duplicate_prediction_is_false_positive_at_operating_point(self) -> None:
        targets = [Target(0, 0, BOX)]
        predictions = [
            Prediction(0, 0, 0.9, BOX),
            Prediction(0, 0, 0.8, BOX),
        ]

        report = evaluate_predictions(predictions, targets, ["smoke", "fire"], 0.25)
        smoke = report["per_class"][0]

        self.assertEqual(smoke["true_positives"], 1)
        self.assertEqual(smoke["false_positives"], 1)
        self.assertEqual(smoke["precision"], 0.5)
        self.assertEqual(smoke["recall"], 1.0)

    def test_score_threshold_only_affects_operating_metrics(self) -> None:
        targets = [Target(0, 0, BOX)]
        predictions = [Prediction(0, 0, 0.2, BOX)]

        report = evaluate_predictions(predictions, targets, ["smoke", "fire"], 0.25)
        smoke = report["per_class"][0]

        self.assertEqual(smoke["recall"], 0.0)
        self.assertEqual(smoke["map50"], 1.0)


if __name__ == "__main__":
    unittest.main()
