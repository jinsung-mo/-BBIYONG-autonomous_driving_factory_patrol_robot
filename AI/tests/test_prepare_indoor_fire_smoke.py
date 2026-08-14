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
from prepare_indoor_fire_smoke import prepare  # noqa: E402


class IndoorFireSmokePreparationTests(unittest.TestCase):
    def make_source(self, root: Path, names: list[str] | None = None) -> Path:
        dataset = root / "Indoor Fire Smoke"
        data = {
            "path": "your_path",
            "train": "train/images",
            "val": "valid/images",
            "test": "test/images",
            "names": names or ["0", "1"],
            "roboflow": {
                "workspace": "object-detection-7qn6l",
                "project": "indoor-fire-smoke",
                "version": 1,
                "license": "CC BY 4.0",
                "url": "https://example.invalid/indoor-fire-smoke",
            },
        }
        dataset.mkdir(parents=True)
        (dataset / "data.yaml").write_text(yaml.safe_dump(data), encoding="utf-8")
        for index, split in enumerate(("train", "valid", "test")):
            image_dir = dataset / split / "images"
            label_dir = dataset / split / "labels"
            image_dir.mkdir(parents=True)
            label_dir.mkdir(parents=True)
            (image_dir / f"{split}.jpg").write_bytes(f"unique-{index}".encode())
            (label_dir / f"{split}.txt").write_text(
                "0 0.25 0.25 0.2 0.2\n1 0.75 0.75 0.3 0.3\n",
                encoding="utf-8",
            )
        return dataset

    def test_remaps_classes_and_preserves_splits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_source(root)
            output_yaml = prepare(source, root / "output")

            output = yaml.safe_load(output_yaml.read_text(encoding="utf-8"))
            self.assertEqual(output["names"], {0: "smoke", 1: "fire"})
            self.assertEqual(output["val"], "images/val")
            for split in ("train", "val", "test"):
                source_name = "valid" if split == "val" else split
                label = root / "output" / "labels" / split / f"{source_name}.txt"
                self.assertEqual(
                    label.read_text(encoding="utf-8").splitlines(),
                    ["1 0.25 0.25 0.2 0.2", "0 0.75 0.75 0.3 0.3"],
                )

            manifest = json.loads(
                (root / "output" / "preparation_manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["class_id_mapping"], {"0": 1, "1": 0})
            self.assertEqual(manifest["splits"]["val"]["images"], 1)
            self.assertEqual(manifest["source_metadata"]["license"], "CC BY 4.0")
            self.assertTrue(validate_dataset(output_yaml).ok)

    def test_accepts_zip_and_ignores_macos_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_source(root / "source")
            archive = root / "indoor.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for path in source.rglob("*"):
                    if path.is_file():
                        output.write(path, path.relative_to(source.parent))
                output.writestr("__MACOSX/Indoor Fire Smoke/._data.yaml", "metadata")

            output_yaml = prepare(archive, root / "output")
            manifest = json.loads(
                (root / "output" / "preparation_manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(len(manifest["source_sha256"]), 64)
            self.assertTrue(validate_dataset(output_yaml).ok)

    def test_rejects_unexpected_source_classes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_source(root, names=["smoke", "fire"])
            with self.assertRaisesRegex(ValueError, "Expected Indoor Fire Smoke source classes"):
                prepare(source, root / "output")

    def test_rejects_missing_label(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = self.make_source(root)
            (source / "valid" / "labels" / "valid.txt").unlink()
            with self.assertRaisesRegex(ValueError, "Missing label"):
                prepare(source, root / "output")


if __name__ == "__main__":
    unittest.main()
