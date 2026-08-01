from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import yaml


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from dataset_utils import validate_dataset  # noqa: E402
from prepare_fasdd_cv import prepare, sanitize_coco_bbox  # noqa: E402


class FasddCvPreparationTests(unittest.TestCase):
    def make_archive(
        self,
        root: Path,
        invalid_box: bool = False,
        duplicate_train_test: bool = False,
    ) -> Path:
        archive_path = root / "FASDD_CV.zip"
        categories = [{"id": 0, "name": "fire"}, {"id": 1, "name": "smoke"}]
        with zipfile.ZipFile(archive_path, "w") as archive:
            for index, split in enumerate(("train", "val", "test"), 1):
                file_name = f"{split}.jpg"
                annotations = [
                    {
                        "id": index * 10,
                        "image_id": index,
                        "category_id": 0,
                        "bbox": [10, 20, 20, 10],
                    },
                    {
                        "id": index * 10 + 1,
                        "image_id": index,
                        "category_id": 1,
                        "bbox": [80, 90, 30, 20],
                    },
                ]
                if invalid_box and split == "train":
                    annotations.append(
                        {
                            "id": 99,
                            "image_id": index,
                            "category_id": 0,
                            "bbox": [5, 5, 0, 10],
                        }
                    )
                images = [
                    {
                        "id": index,
                        "file_name": file_name,
                        "width": 100,
                        "height": 100,
                    }
                ]
                if duplicate_train_test and split == "train":
                    images.append(
                        {
                            "id": 100,
                            "file_name": "train_unique.jpg",
                            "width": 100,
                            "height": 100,
                        }
                    )
                    annotations.append(
                        {
                            "id": 1000,
                            "image_id": 100,
                            "category_id": 0,
                            "bbox": [10, 10, 10, 10],
                        }
                    )
                data = {
                    "images": images,
                    "annotations": annotations,
                    "categories": categories,
                }
                archive.writestr(
                    f"FASDD_CV/annotations/COCO_CV/Annotations/{split}.json",
                    json.dumps(data),
                )
                archive.writestr(
                    f"FASDD_CV/images/{file_name}",
                    (
                        b"shared-train-test"
                        if duplicate_train_test and split in {"train", "test"}
                        else f"unique-image-{split}".encode()
                    ),
                )
                if duplicate_train_test and split == "train":
                    archive.writestr(
                        "FASDD_CV/images/train_unique.jpg",
                        b"unique-train-image",
                    )
        return archive_path

    def test_converts_coco_splits_and_remaps_classes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_archive(root)
            output_yaml = prepare(
                source,
                root / "output",
                sanitize_labels=True,
            )

            output = yaml.safe_load(output_yaml.read_text(encoding="utf-8"))
            self.assertEqual(output["names"], {0: "smoke", 1: "fire"})
            for split in ("train", "val", "test"):
                label = root / "output" / "labels" / split / f"{split}.txt"
                lines = label.read_text(encoding="utf-8").splitlines()
                self.assertEqual(lines[0], "1 0.2 0.25 0.2 0.1")
                self.assertEqual(lines[1], "0 0.9 0.95 0.2 0.1")

            manifest = json.loads(
                (root / "output" / "preparation_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["class_id_mapping"], {"0": 1, "1": 0})
            self.assertEqual(manifest["correction_count"], 3)
            self.assertEqual(manifest["splits"]["train"]["clipped_boxes"], 1)
            self.assertEqual(manifest["splits"]["test"]["images"], 1)
            self.assertTrue(validate_dataset(output_yaml).ok)

    def test_requires_opt_in_for_invalid_boxes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_archive(root, invalid_box=True)
            with self.assertRaisesRegex(ValueError, "--sanitize-labels"):
                prepare(source, root / "strict-output")

            output_yaml = prepare(
                source,
                root / "sanitized-output",
                sanitize_labels=True,
            )
            manifest = json.loads(
                (root / "sanitized-output" / "preparation_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["splits"]["train"]["dropped_boxes"], 1)
            self.assertTrue(validate_dataset(output_yaml).ok)

    def test_sanitizes_coco_bbox(self) -> None:
        self.assertEqual(
            sanitize_coco_bbox([80, 90, 30, 20], 100, 100),
            ([80.0, 90.0, 20.0, 10.0], "clip_to_image"),
        )
        self.assertEqual(
            sanitize_coco_bbox([10, 10, 0, 4], 100, 100),
            (None, "drop_zero_area"),
        )

    def test_deduplicates_splits_with_test_priority(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_archive(root, duplicate_train_test=True)
            output_yaml = prepare(
                source,
                root / "output",
                sanitize_labels=True,
                deduplicate_splits=True,
            )

            self.assertFalse((root / "output" / "images" / "train" / "train.jpg").exists())
            self.assertFalse((root / "output" / "labels" / "train" / "train.txt").exists())
            self.assertTrue((root / "output" / "images" / "test" / "test.jpg").exists())
            manifest = json.loads(
                (root / "output" / "preparation_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["duplicate_removal_count"], 1)
            self.assertEqual(manifest["duplicate_removals"][0]["removed_split"], "train")
            self.assertEqual(manifest["duplicate_removals"][0]["kept_split"], "test")
            self.assertEqual(manifest["splits"]["train"]["images"], 1)
            self.assertTrue(validate_dataset(output_yaml).ok)

    def test_rejects_unexpected_categories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            archive_path = self.make_archive(root)
            rewritten = root / "wrong-categories.zip"
            with zipfile.ZipFile(archive_path) as source, zipfile.ZipFile(
                rewritten, "w"
            ) as destination:
                for item in source.infolist():
                    payload = source.read(item)
                    if item.filename.endswith("/train.json"):
                        data = json.loads(payload)
                        data["categories"] = [
                            {"id": 0, "name": "smoke"},
                            {"id": 1, "name": "fire"},
                        ]
                        payload = json.dumps(data).encode()
                    destination.writestr(item, payload)

            with self.assertRaisesRegex(ValueError, "Expected FASDD-CV categories"):
                prepare(rewritten, root / "output", sanitize_labels=True)


if __name__ == "__main__":
    unittest.main()
