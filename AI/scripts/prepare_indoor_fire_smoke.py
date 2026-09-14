from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

from dataset_utils import IMAGE_SUFFIXES, print_report, sha256, validate_dataset
from prepare_dataset import find_yaml, resolve_source_split, safe_extract, source_label


AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = AI_ROOT / "data" / "downloads" / "indoor-fire-smoke" / "Indoor Fire Smoke.zip"
DEFAULT_DESTINATION = AI_ROOT / "data" / "indoor_fire_smoke"
SOURCE_NAMES = ["fire", "smoke"]
AMBIGUOUS_SOURCE_NAMES = ["0", "1"]
TARGET_NAMES = ["smoke", "fire"]
CLASS_ID_MAPPING = {0: 1, 1: 0}
SPLIT_MAPPING = {"train": "train", "val": "val", "test": "test"}


@dataclass
class SplitConversionStats:
    images: int = 0
    labels: int = 0
    boxes: int = 0
    source_class_boxes: dict[int, int] = field(default_factory=dict)
    target_class_boxes: dict[int, int] = field(default_factory=dict)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert the Indoor Fire Smoke dataset to the BBIYONG smoke/fire contract"
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Source ZIP or extracted directory")
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION, help="Derived dataset directory")
    parser.add_argument("--force", action="store_true", help="Replace an existing destination")
    return parser.parse_args()


def normalized_source_names(data: dict[str, Any]) -> list[str]:
    names = data.get("names")
    if isinstance(names, list):
        normalized = [str(name).strip().lower() for name in names]
    elif isinstance(names, dict):
        indexed = {int(key): str(value).strip().lower() for key, value in names.items()}
        normalized = [indexed[index] for index in range(len(indexed))]
    else:
        raise ValueError("Source data.yaml must define two class names")

    if normalized == AMBIGUOUS_SOURCE_NAMES:
        return SOURCE_NAMES
    if normalized != SOURCE_NAMES:
        raise ValueError(
            "Expected Indoor Fire Smoke source classes ['0', '1'] or "
            f"{SOURCE_NAMES}, got {normalized}"
        )
    return normalized


def convert_label(source: Path, destination: Path, stats: SplitConversionStats) -> None:
    output_lines: list[str] = []
    for line_number, raw_line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        fields = line.split()
        if len(fields) != 5:
            raise ValueError(f"{source}:{line_number}: expected 5 YOLO fields")
        try:
            source_class = int(fields[0])
            coordinates = [float(value) for value in fields[1:]]
        except ValueError as exc:
            raise ValueError(f"{source}:{line_number}: non-numeric YOLO label") from exc
        if source_class not in CLASS_ID_MAPPING:
            raise ValueError(f"{source}:{line_number}: unknown source class {source_class}")
        if any(value < 0.0 or value > 1.0 for value in coordinates):
            raise ValueError(f"{source}:{line_number}: coordinates must be normalized to 0..1")
        if coordinates[2] <= 0.0 or coordinates[3] <= 0.0:
            raise ValueError(f"{source}:{line_number}: width and height must be positive")

        target_class = CLASS_ID_MAPPING[source_class]
        output_lines.append(" ".join([str(target_class), *fields[1:]]))
        stats.boxes += 1
        stats.source_class_boxes[source_class] = stats.source_class_boxes.get(source_class, 0) + 1
        stats.target_class_boxes[target_class] = stats.target_class_boxes.get(target_class, 0) + 1

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(output_lines) + ("\n" if output_lines else ""), encoding="utf-8")


def convert_split(
    source_images: Path,
    destination: Path,
    source_split: str,
    target_split: str,
) -> SplitConversionStats:
    if not source_images.is_dir():
        raise ValueError(f"Source {source_split} image directory does not exist: {source_images}")

    stats = SplitConversionStats()
    target_images = destination / "images" / target_split
    target_labels = destination / "labels" / target_split
    images = sorted(path for path in source_images.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES)
    if not images:
        raise ValueError(f"Source split '{source_split}' contains no supported images")

    for image in images:
        relative = image.relative_to(source_images)
        label = source_label(image, source_images)
        if not label.is_file():
            raise ValueError(f"Missing label for source image: {image}")

        output_image = target_images / relative
        output_image.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(image, output_image)
        convert_label(label, (target_labels / relative).with_suffix(".txt"), stats)
        stats.images += 1
        stats.labels += 1
    return stats


def source_metadata(data: dict[str, Any]) -> dict[str, Any]:
    roboflow = data.get("roboflow")
    if not isinstance(roboflow, dict):
        return {}
    return {
        key: roboflow[key]
        for key in ("workspace", "project", "version", "license", "url")
        if key in roboflow
    }


def prepare(source: Path, destination: Path, force: bool = False) -> Path:
    source = source.resolve()
    destination = destination.resolve()
    if not source.exists():
        raise FileNotFoundError(f"Source does not exist: {source}")
    if destination.exists():
        if not force:
            raise FileExistsError(f"Destination already exists: {destination} (use --force to replace it)")
        shutil.rmtree(destination)

    split_stats: dict[str, SplitConversionStats] = {}
    archive_sha256 = sha256(source) if source.is_file() else None
    with tempfile.TemporaryDirectory(prefix="bbiyong-indoor-fire-") as temp_dir:
        if source.is_file() and source.suffix.lower() == ".zip":
            extracted = Path(temp_dir)
            safe_extract(source, extracted)
            source_root = extracted
        elif source.is_dir():
            source_root = source
        else:
            raise ValueError(f"Source must be a ZIP or directory: {source}")

        source_yaml = find_yaml(source_root)
        with source_yaml.open("r", encoding="utf-8") as stream:
            source_data = yaml.safe_load(stream) or {}
        normalized_source_names(source_data)

        for source_split, target_split in SPLIT_MAPPING.items():
            source_images = resolve_source_split(source_yaml, source_data, source_split)
            if source_images is None:
                raise ValueError(f"Source data.yaml is missing split '{source_split}'")
            split_stats[target_split] = convert_split(
                source_images,
                destination,
                source_split,
                target_split,
            )

    destination.mkdir(parents=True, exist_ok=True)
    output_yaml = destination / "data.yaml"
    output_data = {
        "path": destination.as_posix(),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {index: name for index, name in enumerate(TARGET_NAMES)},
    }
    with output_yaml.open("w", encoding="utf-8") as stream:
        yaml.safe_dump(output_data, stream, sort_keys=False, allow_unicode=True)

    manifest = {
        "dataset": "Indoor Fire Smoke",
        "source": source.as_posix(),
        "source_sha256": archive_sha256,
        "source_classes": {index: name for index, name in enumerate(SOURCE_NAMES)},
        "target_classes": {index: name for index, name in enumerate(TARGET_NAMES)},
        "class_id_mapping": {"0": 1, "1": 0},
        "split_mapping": SPLIT_MAPPING,
        "source_metadata": source_metadata(source_data),
        "splits": {split: asdict(stats) for split, stats in split_stats.items()},
    }
    (destination / "preparation_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return output_yaml


def main() -> int:
    args = parse_args()
    try:
        output_yaml = prepare(args.source, args.destination, args.force)
        report = validate_dataset(output_yaml)
        print_report(report)
        if not report.ok:
            return 1
        print(f"Prepared Indoor Fire Smoke dataset: {output_yaml}")
        return 0
    except (
        FileNotFoundError,
        FileExistsError,
        KeyError,
        ValueError,
        zipfile.BadZipFile,
    ) as exc:
        print(f"ERROR: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
