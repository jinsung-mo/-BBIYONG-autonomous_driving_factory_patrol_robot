from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import yaml


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from dataset_utils import validate_dataset  # noqa: E402
from prepare_dataset import prepare  # noqa: E402


class DatasetValidationTests(unittest.TestCase):
    def make_dataset(self, root: Path) -> Path:
        for split in ("train", "val"):
            image_dir = root / "images" / split
            label_dir = root / "labels" / split
            image_dir.mkdir(parents=True)
            label_dir.mkdir(parents=True)
            (image_dir / f"{split}.jpg").write_bytes(f"fake-{split}".encode())
            (label_dir / f"{split}.txt").write_text("0 0.5 0.5 0.2 0.3\n", encoding="utf-8")
        yaml_path = root / "data.yaml"
        yaml_path.write_text(
            yaml.safe_dump(
                {
                    "path": str(root),
                    "train": "images/train",
                    "val": "images/val",
                    "names": {0: "fire", 1: "smoke"},
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return yaml_path

    def test_valid_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            report = validate_dataset(self.make_dataset(Path(temp_dir)))
            self.assertTrue(report.ok, report.errors)
            self.assertEqual(report.splits["train"].boxes, 1)

    def test_rejects_out_of_range_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            yaml_path = self.make_dataset(root)
            (root / "labels" / "train" / "train.txt").write_text(
                "0 1.2 0.5 0.2 0.3\n", encoding="utf-8"
            )
            report = validate_dataset(yaml_path)
            self.assertFalse(report.ok)
            self.assertTrue(any("normalized" in error for error in report.errors))

    def test_detects_split_leakage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            yaml_path = self.make_dataset(root)
            duplicate = (root / "images" / "train" / "train.jpg").read_bytes()
            (root / "images" / "val" / "val.jpg").write_bytes(duplicate)
            report = validate_dataset(yaml_path)
            self.assertFalse(report.ok)
            self.assertTrue(any("Split leakage" in error for error in report.errors))

    def test_prepares_common_roboflow_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            for split in ("train", "valid"):
                image_dir = source / split / "images"
                label_dir = source / split / "labels"
                image_dir.mkdir(parents=True)
                label_dir.mkdir(parents=True)
                (image_dir / f"{split}.jpg").write_bytes(f"image-{split}".encode())
                (label_dir / f"{split}.txt").write_text("1 0.5 0.5 0.2 0.2\n", encoding="utf-8")
            (source / "data.yaml").write_text(
                yaml.safe_dump(
                    {
                        "train": "../train/images",
                        "val": "../valid/images",
                        "names": ["smoke", "fire"],
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            output_yaml = prepare(source, root / "prepared", force=False)
            report = validate_dataset(output_yaml)

            self.assertTrue(report.ok, report.errors)
            self.assertEqual(report.splits["train"].images, 1)
            self.assertEqual(report.splits["val"].class_boxes[0], 1)


if __name__ == "__main__":
    unittest.main()
