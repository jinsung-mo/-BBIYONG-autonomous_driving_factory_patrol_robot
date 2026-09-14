from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from train import (  # noqa: E402
    AUGMENTATION_PRESETS,
    augmentation_args,
    normalized_model_names,
    resolve_initial_weights,
    validate_checkpoint_classes,
)


class TrainingConfigurationTests(unittest.TestCase):
    def test_fire_smoke_augmentation_is_moderate(self) -> None:
        preset = augmentation_args("fire-smoke")
        self.assertEqual(preset["flipud"], 0.0)
        self.assertEqual(preset["fliplr"], 0.5)
        self.assertLess(preset["mosaic"], AUGMENTATION_PRESETS["ultralytics"]["mosaic"])
        self.assertLess(preset["hsv_s"], AUGMENTATION_PRESETS["ultralytics"]["hsv_s"])
        self.assertGreater(preset["mixup"], 0.0)

    def test_returned_preset_is_a_copy(self) -> None:
        preset = augmentation_args("fire-smoke")
        preset["mosaic"] = 0.0
        self.assertEqual(AUGMENTATION_PRESETS["fire-smoke"]["mosaic"], 0.5)

    def test_resolves_best_checkpoint_for_new_finetuning_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            checkpoint = Path(temp_dir) / "dfire-yolo11s" / "weights" / "best.pt"
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_bytes(b"checkpoint")

            weights, run_name, custom = resolve_initial_weights(
                "yolo11n.pt",
                checkpoint,
            )

            self.assertEqual(weights, str(checkpoint.resolve()))
            self.assertEqual(run_name, "dfire-yolo11s-finetune")
            self.assertTrue(custom)

    def test_rejects_missing_initialization_checkpoint(self) -> None:
        with self.assertRaisesRegex(SystemExit, "does not exist"):
            resolve_initial_weights("yolo11n.pt", Path("missing-best.pt"))

    def test_normalizes_checkpoint_class_names(self) -> None:
        class FakeModel:
            names = {0: " Smoke ", 1: "FIRE"}

        self.assertEqual(normalized_model_names(FakeModel()), ["smoke", "fire"])

    def test_rejects_reversed_checkpoint_class_names(self) -> None:
        class FakeModel:
            names = {0: "fire", 1: "smoke"}

        with self.assertRaisesRegex(SystemExit, "expected"):
            validate_checkpoint_classes(FakeModel())


if __name__ == "__main__":
    unittest.main()
