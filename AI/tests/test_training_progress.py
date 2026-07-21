from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from training_progress import TrainingProgress, format_duration  # noqa: E402


class TrainingProgressTests(unittest.TestCase):
    def test_format_duration(self) -> None:
        self.assertEqual(format_duration(5), "5s")
        self.assertEqual(format_duration(65), "1m 05s")
        self.assertEqual(format_duration(3661), "1h 01m 01s")
        self.assertEqual(format_duration(None), "unknown")

    def test_writes_epoch_snapshot_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            trainer = SimpleNamespace(
                save_dir=Path(temp_dir),
                start_epoch=0,
                epoch=0,
                epochs=10,
                tloss=1.25,
                metrics={"metrics/recall(B)": 0.75},
                lr={"lr/pg0": 0.001},
                label_loss_items=lambda value: {"train/loss": value},
            )
            progress = TrainingProgress()

            progress.on_train_start(trainer)
            progress.on_fit_epoch_end(trainer)

            snapshot = json.loads((Path(temp_dir) / "progress.json").read_text(encoding="utf-8"))
            history = (Path(temp_dir) / "progress.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(snapshot["status"], "training")
            self.assertEqual(snapshot["epoch_completed"], 1)
            self.assertEqual(snapshot["epochs_total"], 10)
            self.assertEqual(snapshot["percent"], 10.0)
            self.assertEqual(snapshot["metrics"]["metrics/recall(B)"], 0.75)
            self.assertEqual(len(history), 2)


if __name__ == "__main__":
    unittest.main()
