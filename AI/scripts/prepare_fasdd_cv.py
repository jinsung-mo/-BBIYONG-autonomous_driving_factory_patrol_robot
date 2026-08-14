from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

import yaml

from dataset_utils import IMAGE_SUFFIXES, print_report, sha256, validate_dataset


AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = AI_ROOT / "data" / "downloads" / "fasdd-cv" / "FASDD_CV.zip"
DEFAULT_DESTINATION = AI_ROOT / "data" / "fasdd_cv"
SOURCE_NAMES = {0: "fire", 1: "smoke"}
TARGET_NAMES = {0: "smoke", 1: "fire"}
CLASS_ID_MAPPING = {0: 1, 1: 0}
SPLITS = ("train", "val", "test")
ARCHIVE_ROOT = PurePosixPath("FASDD_CV")
COCO_RELATIVE_ROOT = PurePosixPath("annotations/COCO_CV/Annotations")
IMAGE_RELATIVE_ROOT = PurePosixPath("images")


@dataclass
class SplitConversionStats:
    images: int = 0
    labels: int = 0
    boxes: int = 0
    source_class_boxes: dict[int, int] = field(default_factory=dict)
    target_class_boxes: dict[int, int] = field(default_factory=dict)
    clipped_boxes: int = 0
    dropped_boxes: int = 0


@dataclass
class Correction:
    split: str
    image: str
    annotation_id: int | str | None
    action: str
    original_bbox: list[float]
    corrected_bbox: list[float] | None = None


@dataclass
class DuplicateRemoval:
    removed_split: str
    removed_image: str
    kept_split: str
    kept_image: str
    sha256: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert FASDD-CV COCO annotations to the BBIYONG smoke/fire YOLO contract"
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help="FASDD_CV ZIP or directory",
    )
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument("--force", action="store_true", help="Replace an existing destination")
    parser.add_argument(
        "--sanitize-labels",
        action="store_true",
        help="Clip boxes to image bounds and drop zero-area boxes, recording every correction",
    )
    parser.add_argument(
        "--deduplicate-splits",
        action="store_true",
        help=(
            "Remove byte-identical images shared across splits, retaining test before "
            "validation before train"
        ),
    )
    return parser.parse_args()


def normalized_categories(data: dict[str, Any]) -> dict[int, str]:
    categories = data.get("categories")
    if not isinstance(categories, list):
        raise ValueError("COCO annotations must define a categories list")
    normalized = {
        int(category["id"]): str(category["name"]).strip().lower()
        for category in categories
    }
    if normalized != SOURCE_NAMES:
        raise ValueError(f"Expected FASDD-CV categories {SOURCE_NAMES}, got {normalized}")
    return normalized


def sanitize_coco_bbox(
    bbox: list[float],
    image_width: int,
    image_height: int,
) -> tuple[list[float] | None, str | None]:
    if len(bbox) != 4:
        raise ValueError(f"Expected a four-value COCO bbox, got {bbox!r}")
    x, y, width, height = (float(value) for value in bbox)
    if width <= 0.0 or height <= 0.0:
        return None, "drop_zero_area"

    left = max(0.0, min(float(image_width), x))
    top = max(0.0, min(float(image_height), y))
    right = max(0.0, min(float(image_width), x + width))
    bottom = max(0.0, min(float(image_height), y + height))
    if right <= left or bottom <= top:
        return None, "drop_outside_image"

    sanitized = [left, top, right - left, bottom - top]
    if sanitized != [x, y, width, height]:
        return sanitized, "clip_to_image"
    return sanitized, None


def yolo_line(category_id: int, bbox: list[float], width: int, height: int) -> str:
    x, y, box_width, box_height = bbox
    target_class = CLASS_ID_MAPPING[category_id]
    values = (
        (x + box_width / 2.0) / width,
        (y + box_height / 2.0) / height,
        box_width / width,
        box_height / height,
    )
    return " ".join([str(target_class), *(f"{value:.12g}" for value in values)])


def validate_relative_image_name(file_name: str) -> PurePosixPath:
    relative = PurePosixPath(file_name)
    if relative.is_absolute() or ".." in relative.parts or not relative.name:
        raise ValueError(f"Unsafe COCO image file_name: {file_name!r}")
    return relative


def convert_split_annotations(
    data: dict[str, Any],
    split: str,
    destination: Path,
    sanitize_labels: bool,
    corrections: list[Correction],
) -> tuple[SplitConversionStats, list[dict[str, Any]]]:
    normalized_categories(data)
    images = data.get("images")
    annotations = data.get("annotations")
    if not isinstance(images, list) or not isinstance(annotations, list):
        raise ValueError(f"{split}: COCO annotations must define images and annotations lists")

    image_by_id: dict[int, dict[str, Any]] = {}
    for image in images:
        image_id = int(image["id"])
        if image_id in image_by_id:
            raise ValueError(f"{split}: duplicate COCO image ID {image_id}")
        validate_relative_image_name(str(image["file_name"]))
        if int(image["width"]) <= 0 or int(image["height"]) <= 0:
            raise ValueError(f"{split}: image {image_id} has invalid dimensions")
        image_by_id[image_id] = image

    annotations_by_image: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for annotation in annotations:
        image_id = int(annotation["image_id"])
        if image_id not in image_by_id:
            raise ValueError(f"{split}: annotation references missing image ID {image_id}")
        annotations_by_image[image_id].append(annotation)

    stats = SplitConversionStats()
    labels_root = destination / "labels" / split
    labels_root.mkdir(parents=True, exist_ok=True)
    ordered_images = sorted(images, key=lambda image: str(image["file_name"]))
    for image in ordered_images:
        image_id = int(image["id"])
        image_name = validate_relative_image_name(str(image["file_name"]))
        width = int(image["width"])
        height = int(image["height"])
        output_lines: list[str] = []
        for annotation in sorted(
            annotations_by_image[image_id],
            key=lambda item: (str(item.get("id", "")), int(item["category_id"])),
        ):
            source_class = int(annotation["category_id"])
            if source_class not in CLASS_ID_MAPPING:
                raise ValueError(
                    f"{split}/{image_name}: unknown category ID {source_class}"
                )
            try:
                original_bbox = [float(value) for value in annotation["bbox"]]
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(
                    f"{split}/{image_name}: annotation {annotation.get('id')} has an invalid bbox"
                ) from exc
            sanitized, action = sanitize_coco_bbox(original_bbox, width, height)
            if action and not sanitize_labels:
                raise ValueError(
                    f"{split}/{image_name}: annotation {annotation.get('id')} requires "
                    f"{action}; rerun with --sanitize-labels"
                )
            if action:
                corrections.append(
                    Correction(
                        split=split,
                        image=image_name.as_posix(),
                        annotation_id=annotation.get("id"),
                        action=action,
                        original_bbox=original_bbox,
                        corrected_bbox=sanitized,
                    )
                )
            if sanitized is None:
                stats.dropped_boxes += 1
                continue
            if action == "clip_to_image":
                stats.clipped_boxes += 1
            output_lines.append(yolo_line(source_class, sanitized, width, height))
            stats.boxes += 1
            stats.source_class_boxes[source_class] = (
                stats.source_class_boxes.get(source_class, 0) + 1
            )
            target_class = CLASS_ID_MAPPING[source_class]
            stats.target_class_boxes[target_class] = (
                stats.target_class_boxes.get(target_class, 0) + 1
            )

        label_path = (labels_root / Path(*image_name.parts)).with_suffix(".txt")
        label_path.parent.mkdir(parents=True, exist_ok=True)
        label_path.write_text(
            "\n".join(output_lines) + ("\n" if output_lines else ""),
            encoding="utf-8",
        )
        stats.images += 1
        stats.labels += 1
    return stats, ordered_images


def find_extracted_root(source: Path) -> Path:
    candidates = [
        candidate.parent.parent.parent.parent
        for candidate in source.rglob("annotations/COCO_CV/Annotations/train.json")
    ]
    if len(candidates) != 1:
        raise ValueError(f"Expected one extracted FASDD_CV root, found {len(candidates)}")
    root = candidates[0]
    if not (root / "images").is_dir():
        raise ValueError(f"FASDD-CV images directory does not exist: {root / 'images'}")
    return root


def copy_stream(source: BinaryIO, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        shutil.copyfileobj(source, output, length=1024 * 1024)


def remove_cross_split_duplicates(
    destination: Path,
    split_stats: dict[str, SplitConversionStats],
) -> list[DuplicateRemoval]:
    """Remove source leakage while protecting evaluation splits.

    Test images take precedence over validation images, which take precedence
    over training images. Duplicate copies within the same split are retained
    because they do not leak evaluation data across split boundaries.
    """

    seen_hashes: dict[str, tuple[str, Path]] = {}
    removals: list[DuplicateRemoval] = []
    for split in ("test", "val", "train"):
        image_root = destination / "images" / split
        label_root = destination / "labels" / split
        images = sorted(
            path
            for path in image_root.rglob("*")
            if path.suffix.lower() in IMAGE_SUFFIXES
        )
        for image in images:
            digest = sha256(image)
            previous = seen_hashes.get(digest)
            if previous is None:
                seen_hashes[digest] = (split, image)
                continue
            kept_split, kept_image = previous
            if kept_split == split:
                continue

            relative = image.relative_to(image_root)
            label = (label_root / relative).with_suffix(".txt")
            label_lines = (
                [line for line in label.read_text(encoding="utf-8").splitlines() if line.strip()]
                if label.is_file()
                else []
            )
            stats = split_stats[split]
            stats.images -= 1
            if label.is_file():
                stats.labels -= 1
            for line in label_lines:
                target_class = int(line.split()[0])
                source_class = target_class ^ 1
                stats.boxes -= 1
                stats.target_class_boxes[target_class] -= 1
                stats.source_class_boxes[source_class] -= 1

            image.unlink()
            if label.is_file():
                label.unlink()
            removals.append(
                DuplicateRemoval(
                    removed_split=split,
                    removed_image=relative.as_posix(),
                    kept_split=kept_split,
                    kept_image=kept_image.relative_to(
                        destination / "images" / kept_split
                    ).as_posix(),
                    sha256=digest,
                )
            )
    return removals


def prepare_from_zip(
    source: Path,
    destination: Path,
    sanitize_labels: bool,
    corrections: list[Correction],
) -> dict[str, SplitConversionStats]:
    split_stats: dict[str, SplitConversionStats] = {}
    seen_names: set[PurePosixPath] = set()
    with zipfile.ZipFile(source) as archive:
        archive_names = set(archive.namelist())
        for split in SPLITS:
            annotation_name = (
                ARCHIVE_ROOT / COCO_RELATIVE_ROOT / f"{split}.json"
            ).as_posix()
            if annotation_name not in archive_names:
                raise ValueError(f"Missing FASDD-CV annotation entry: {annotation_name}")
            with archive.open(annotation_name) as stream:
                data = json.load(stream)
            stats, images = convert_split_annotations(
                data, split, destination, sanitize_labels, corrections
            )
            for image in images:
                relative = validate_relative_image_name(str(image["file_name"]))
                if relative in seen_names:
                    raise ValueError(f"Image appears in more than one split: {relative}")
                seen_names.add(relative)
                source_name = (ARCHIVE_ROOT / IMAGE_RELATIVE_ROOT / relative).as_posix()
                if source_name not in archive_names:
                    raise ValueError(f"Missing source image in archive: {source_name}")
                output_image = destination / "images" / split / Path(*relative.parts)
                with archive.open(source_name) as image_stream:
                    copy_stream(image_stream, output_image)
            split_stats[split] = stats
    return split_stats


def prepare_from_directory(
    source: Path,
    destination: Path,
    sanitize_labels: bool,
    corrections: list[Correction],
) -> dict[str, SplitConversionStats]:
    root = find_extracted_root(source)
    split_stats: dict[str, SplitConversionStats] = {}
    seen_names: set[PurePosixPath] = set()
    for split in SPLITS:
        annotation_path = root / "annotations" / "COCO_CV" / "Annotations" / f"{split}.json"
        if not annotation_path.is_file():
            raise ValueError(f"Missing FASDD-CV annotation file: {annotation_path}")
        data = json.loads(annotation_path.read_text(encoding="utf-8"))
        stats, images = convert_split_annotations(
            data, split, destination, sanitize_labels, corrections
        )
        for image in images:
            relative = validate_relative_image_name(str(image["file_name"]))
            if relative in seen_names:
                raise ValueError(f"Image appears in more than one split: {relative}")
            seen_names.add(relative)
            source_image = root / "images" / Path(*relative.parts)
            if not source_image.is_file():
                raise ValueError(f"Missing source image: {source_image}")
            output_image = destination / "images" / split / Path(*relative.parts)
            output_image.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_image, output_image)
        split_stats[split] = stats
    return split_stats


def prepare(
    source: Path,
    destination: Path,
    force: bool = False,
    sanitize_labels: bool = False,
    deduplicate_splits: bool = False,
) -> Path:
    source = source.resolve()
    destination = destination.resolve()
    if not source.exists():
        raise FileNotFoundError(f"Source does not exist: {source}")
    if destination.exists():
        if not force:
            raise FileExistsError(
                f"Destination already exists: {destination} (use --force to replace it)"
            )
        shutil.rmtree(destination)

    corrections: list[Correction] = []
    if source.is_file() and source.suffix.lower() == ".zip":
        split_stats = prepare_from_zip(
            source, destination, sanitize_labels, corrections
        )
        source_digest = sha256(source)
    elif source.is_dir():
        split_stats = prepare_from_directory(
            source, destination, sanitize_labels, corrections
        )
        source_digest = None
    else:
        raise ValueError(f"Source must be a ZIP or directory: {source}")

    duplicate_removals = (
        remove_cross_split_duplicates(destination, split_stats)
        if deduplicate_splits
        else []
    )
    output_yaml = destination / "data.yaml"
    output_data = {
        "path": destination.as_posix(),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": TARGET_NAMES,
    }
    with output_yaml.open("w", encoding="utf-8") as stream:
        yaml.safe_dump(output_data, stream, sort_keys=False, allow_unicode=True)

    manifest = {
        "dataset": "FASDD-CV",
        "source": source.as_posix(),
        "source_sha256": source_digest,
        "source_format": "COCO",
        "source_classes": SOURCE_NAMES,
        "target_classes": TARGET_NAMES,
        "class_id_mapping": {"0": 1, "1": 0},
        "sanitize_labels": sanitize_labels,
        "correction_count": len(corrections),
        "corrections": [asdict(correction) for correction in corrections],
        "deduplicate_splits": deduplicate_splits,
        "duplicate_removal_count": len(duplicate_removals),
        "duplicate_removals": [
            asdict(duplicate_removal) for duplicate_removal in duplicate_removals
        ],
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
        output_yaml = prepare(
            args.source,
            args.destination,
            force=args.force,
            sanitize_labels=args.sanitize_labels,
            deduplicate_splits=args.deduplicate_splits,
        )
        report = validate_dataset(output_yaml)
        print_report(report)
        if not report.ok:
            return 1
        print(f"Prepared FASDD-CV dataset: {output_yaml}")
        return 0
    except (
        FileNotFoundError,
        FileExistsError,
        KeyError,
        TypeError,
        ValueError,
        zipfile.BadZipFile,
    ) as exc:
        print(f"ERROR: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
