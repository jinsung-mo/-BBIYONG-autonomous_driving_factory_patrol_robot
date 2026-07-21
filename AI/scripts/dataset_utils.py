from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


IMAGE_SUFFIXES = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
REQUIRED_SPLITS = ("train", "val")
ALL_SPLITS = ("train", "val", "test")


@dataclass
class SplitStats:
    images: int = 0
    labels: int = 0
    negatives: int = 0
    boxes: int = 0
    class_boxes: dict[int, int] = field(default_factory=dict)


@dataclass
class ValidationReport:
    names: list[str]
    splits: dict[str, SplitStats]
    warnings: list[str]
    errors: list[str]

    @property
    def ok(self) -> bool:
        return not self.errors


def load_dataset_yaml(yaml_path: Path) -> dict[str, Any]:
    with yaml_path.open("r", encoding="utf-8") as stream:
        data = yaml.safe_load(stream) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Dataset YAML must contain a mapping: {yaml_path}")
    return data


def class_names(data: dict[str, Any]) -> list[str]:
    names = data.get("names")
    if isinstance(names, list):
        return [str(name).strip().lower() for name in names]
    if isinstance(names, dict):
        try:
            return [str(names[index]).strip().lower() for index in range(len(names))]
        except (KeyError, TypeError):
            normalized = {int(key): value for key, value in names.items()}
            return [str(normalized[index]).strip().lower() for index in range(len(normalized))]
    raise ValueError("Dataset YAML must define 'names' as a list or zero-based mapping")


def dataset_root(yaml_path: Path, data: dict[str, Any]) -> Path:
    raw_root = Path(str(data.get("path", "."))).expanduser()
    if raw_root.is_absolute():
        return raw_root.resolve()
    return (yaml_path.parent / raw_root).resolve()


def split_image_dir(root: Path, data: dict[str, Any], split: str) -> Path | None:
    value = data.get(split)
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(f"Only one directory per split is supported; got {split}={value!r}")
    candidate = Path(value)
    return candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()


def label_path_for(image_path: Path, image_dir: Path, label_dir: Path) -> Path:
    return (label_dir / image_path.relative_to(image_dir)).with_suffix(".txt")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_dataset(yaml_path: Path) -> ValidationReport:
    yaml_path = yaml_path.resolve()
    data = load_dataset_yaml(yaml_path)
    names = class_names(data)
    root = dataset_root(yaml_path, data)
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict[str, SplitStats] = {}
    seen_hashes: dict[str, tuple[str, Path]] = {}

    if not names:
        errors.append("No classes are defined")

    for split in ALL_SPLITS:
        try:
            image_dir = split_image_dir(root, data, split)
        except ValueError as exc:
            errors.append(str(exc))
            continue

        if image_dir is None:
            if split in REQUIRED_SPLITS:
                errors.append(f"Required split '{split}' is missing from the YAML")
            continue
        if not image_dir.is_dir():
            errors.append(f"Image directory does not exist for {split}: {image_dir}")
            continue

        label_dir = root / "labels" / split
        split_stats = SplitStats()
        stats[split] = split_stats
        images = sorted(path for path in image_dir.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES)
        split_stats.images = len(images)
        if not images:
            errors.append(f"Split '{split}' contains no supported images")
            continue

        referenced_labels: set[Path] = set()
        for image_path in images:
            digest = sha256(image_path)
            previous = seen_hashes.get(digest)
            if previous and previous[0] != split:
                errors.append(
                    f"Split leakage: identical image bytes in {previous[0]} and {split}: "
                    f"{previous[1]} / {image_path}"
                )
            else:
                seen_hashes[digest] = (split, image_path)

            label_path = label_path_for(image_path, image_dir, label_dir)
            if not label_path.exists():
                split_stats.negatives += 1
                continue
            referenced_labels.add(label_path.resolve())
            split_stats.labels += 1
            has_boxes = False
            for line_number, raw_line in enumerate(label_path.read_text(encoding="utf-8").splitlines(), 1):
                line = raw_line.strip()
                if not line:
                    continue
                has_boxes = True
                fields = line.split()
                if len(fields) != 5:
                    errors.append(f"{label_path}:{line_number}: expected 5 fields, got {len(fields)}")
                    continue
                try:
                    class_id = int(fields[0])
                    coordinates = [float(value) for value in fields[1:]]
                except ValueError:
                    errors.append(f"{label_path}:{line_number}: non-numeric label")
                    continue
                if class_id < 0 or class_id >= len(names):
                    errors.append(f"{label_path}:{line_number}: class {class_id} is outside 0..{len(names)-1}")
                if any(value < 0.0 or value > 1.0 for value in coordinates):
                    errors.append(f"{label_path}:{line_number}: coordinates must be normalized to 0..1")
                if coordinates[2] <= 0.0 or coordinates[3] <= 0.0:
                    errors.append(f"{label_path}:{line_number}: width and height must be positive")
                split_stats.boxes += 1
                split_stats.class_boxes[class_id] = split_stats.class_boxes.get(class_id, 0) + 1
            if not has_boxes:
                split_stats.negatives += 1

        if label_dir.exists():
            orphaned = [
                label for label in label_dir.rglob("*.txt") if label.resolve() not in referenced_labels
            ]
            if orphaned:
                warnings.append(f"{split}: {len(orphaned)} label files have no matching image")
        if split_stats.negatives:
            warnings.append(
                f"{split}: {split_stats.negatives} images have no boxes and are treated as negatives"
            )

    return ValidationReport(names=names, splits=stats, warnings=warnings, errors=errors)


def print_report(report: ValidationReport) -> None:
    print(f"classes: {report.names}")
    for split, stats in report.splits.items():
        per_class = ", ".join(f"{key}:{value}" for key, value in sorted(stats.class_boxes.items())) or "none"
        print(
            f"{split}: images={stats.images}, label_files={stats.labels}, negatives={stats.negatives}, "
            f"boxes={stats.boxes}, class_boxes={per_class}"
        )
    for warning in report.warnings:
        print(f"WARNING: {warning}")
    for error in report.errors:
        print(f"ERROR: {error}")
