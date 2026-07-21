from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from train import AUGMENTATION_PRESETS, augmentation_args  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
