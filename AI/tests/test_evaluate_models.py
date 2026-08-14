from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from evaluate_models import (  # noqa: E402
    extract_metrics,
    metrics_match,
    normalize_names,
    parse_model_specs,
    summarize_repeats,
    write_csv,
)


class FakeBoxMetrics:
    def mean_results(self):
        return (0.8, 0.7, 0.6, 0.5)

    def class_result(self, index):
        return ((0.9, 0.8, 0.7, 0.6), (0.7, 0.6, 0.5, 0.4))[index]


class EvaluateModelsTests(unittest.TestCase):
    def test_requires_all_three_named_models(self) -> None:
        with self.assertRaisesRegex(ValueError, "Missing model.*yolo26n"):
            parse_model_specs(["yolo11n=a.pt", "yolo11s=b.pt"])
        models = parse_model_specs(
            ["yolo26n=c.pt", "yolo11n=a.pt", "yolo11s=b.pt"]
        )
        self.assertEqual(list(models), ["yolo11n", "yolo11s", "yolo26n"])

    def test_extracts_aggregate_and_class_metrics(self) -> None:
        results = type("Results", (), {"box": FakeBoxMetrics()})()
        aggregate, classes = extract_metrics(results, {0: "smoke", 1: "fire"})
        self.assertEqual(aggregate["map50_95"], 0.5)
        self.assertEqual(classes[0]["class_name"], "smoke")
        self.assertEqual(classes[1]["recall"], 0.6)
        self.assertEqual(normalize_names(["smoke", "fire"]), {0: "smoke", 1: "fire"})

    def test_writes_aggregate_and_per_class_csv_rows(self) -> None:
        record = {
            "model": "yolo11n",
            "parameters": 1,
            "checkpoint_mb": 2.0,
            "speed_ms": {"preprocess": 1.0, "inference": 2.0, "postprocess": 3.0},
            "aggregate": {"precision": 0.8, "recall": 0.7, "map50": 0.6, "map50_95": 0.5},
            "per_class": [
                {"class_id": 0, "class_name": "smoke", "precision": 0.9, "recall": 0.8, "map50": 0.7, "map50_95": 0.6},
                {"class_id": 1, "class_name": "fire", "precision": 0.7, "recall": 0.6, "map50": 0.5, "map50_95": 0.4},
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "comparison.csv"
            write_csv([record], path)
            with path.open(encoding="utf-8") as stream:
                rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["scope"], "all")
        self.assertEqual(rows[1]["class_name"], "smoke")

    def test_summarizes_repeated_evaluations(self) -> None:
        repeats = []
        for repeat, offset in enumerate((0.0, 0.2), start=1):
            repeats.append(
                {
                    "repeat": repeat,
                    "aggregate": {
                        "precision": 0.8 + offset,
                        "recall": 0.7 + offset,
                        "map50": 0.6 + offset,
                        "map50_95": 0.5 + offset,
                    },
                    "per_class": [
                        {
                            "class_id": 0,
                            "class_name": "smoke",
                            "precision": 0.8 + offset,
                            "recall": 0.7 + offset,
                            "map50": 0.6 + offset,
                            "map50_95": 0.5 + offset,
                        }
                    ],
                    "speed_ms": {"inference": 2.0 + offset},
                    "plots_directory": f"repeat-{repeat}",
                }
            )
        summary = summarize_repeats(repeats)
        self.assertEqual(summary["repeat_count"], 2)
        self.assertAlmostEqual(summary["aggregate"]["map50_95"], 0.6)
        self.assertAlmostEqual(summary["aggregate_std"]["map50_95"], 0.1)
        self.assertAlmostEqual(summary["speed_ms"]["inference"], 2.1)
        self.assertFalse(metrics_match(repeats))
        self.assertTrue(metrics_match([repeats[0], repeats[0]]))


if __name__ == "__main__":
    unittest.main()
