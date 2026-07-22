from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from training_evaluation import BeforeAfterEvaluation, build_comparison, read_best_epoch  # noqa: E402


class TrainingEvaluationTests(unittest.TestCase):
    def test_selects_best_epoch_and_compares_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            results = Path(temp_dir) / "results.csv"
            with results.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(
                    stream,
                    fieldnames=("epoch", "val/box_loss", "metrics/mAP50-95(B)"),
                )
                writer.writeheader()
                writer.writerow({"epoch": 1, "val/box_loss": 2.0, "metrics/mAP50-95(B)": 0.1})
                writer.writerow({"epoch": 2, "val/box_loss": 1.0, "metrics/mAP50-95(B)": 0.4})

            best = read_best_epoch(results)
            comparison = build_comparison(
                {"val/box_loss": 3.0, "metrics/mAP50-95(B)": 0.0}, best
            )

            self.assertEqual(best["epoch"], 2.0)
            self.assertEqual(comparison[0]["delta"], -2.0)

    def test_writes_complete_before_after_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            save_dir = Path(temp_dir)

            class FakeValidator:
                def __init__(self) -> None:
                    self.args = SimpleNamespace(plots=True, split="val")
                    self.dataloader = object()

                def __call__(self, trainer):
                    trained = trainer.ema.ema is best_model
                    return {
                        "val/box_loss": 1.5 if trained else 3.0,
                        "val/cls_loss": 2.0 if trained else 4.0,
                        "val/dfl_loss": 1.0 if trained else 2.0,
                        "metrics/mAP50-95(B)": 0.3 if trained else 0.0,
                        "fitness": 0.3 if trained else 0.0,
                    }

            validator = FakeValidator()
            best_model = SimpleNamespace(args=None)
            created_loaders = []

            class FakeLoader:
                def __init__(self) -> None:
                    self.closed = False

                def close(self) -> None:
                    self.closed = True

            def get_dataloader(*args, **kwargs):
                loader = FakeLoader()
                created_loaders.append(loader)
                return loader

            trainer = SimpleNamespace(
                save_dir=save_dir,
                validator=validator,
                best_fitness=0.5,
                loss_names=("box_loss", "cls_loss", "dfl_loss"),
                device=torch.device("cpu"),
                data={"test": "fake-test-images"},
                batch_size=4,
                world_size=1,
                args=SimpleNamespace(task="detect"),
                ema=SimpleNamespace(ema="initialized-model"),
                best=save_dir / "weights" / "best.pt",
                get_dataloader=get_dataloader,
            )
            evaluation = BeforeAfterEvaluation()
            evaluation.on_train_epoch_start(trainer)
            self.assertEqual(trainer.best_fitness, 0.5)
            self.assertTrue(validator.args.plots)
            self.assertEqual(tuple(trainer.loss_items.shape), (3,))
            self.assertTrue(created_loaders[0].closed)
            self.assertIsNone(evaluation.comparison_loader)

            with (save_dir / "results.csv").open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(
                    stream,
                    fieldnames=(
                        "epoch",
                        "val/box_loss",
                        "val/cls_loss",
                        "val/dfl_loss",
                        "metrics/mAP50-95(B)",
                    ),
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "epoch": 1,
                        "val/box_loss": 1.5,
                        "val/cls_loss": 2.0,
                        "val/dfl_loss": 1.0,
                        "metrics/mAP50-95(B)": 0.3,
                    }
                )

            with patch("training_evaluation.load_checkpoint", return_value=(best_model, {})):
                evaluation.on_train_end(trainer)
            report = json.loads(
                (save_dir / "before_after_evaluation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["best_epoch"], 1)
            self.assertEqual(report["comparison_split"], "test")
            self.assertEqual(report["comparison"][0]["metric"], "test/box_loss")
            self.assertEqual(report["comparison"][0]["delta"], -1.5)
            self.assertEqual(len(created_loaders), 2)
            self.assertTrue(created_loaders[1].closed)
            self.assertTrue((save_dir / "before_after_evaluation.csv").is_file())
            self.assertTrue((save_dir / "loss_before_after.png").is_file())


if __name__ == "__main__":
    unittest.main()
