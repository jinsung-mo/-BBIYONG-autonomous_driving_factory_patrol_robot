from __future__ import annotations

import argparse
import shutil
import tempfile
import zipfile
from pathlib import Path

import yaml

from dataset_utils import ALL_SPLITS, IMAGE_SUFFIXES, class_names, print_report, validate_dataset


EXPECTED_NAMES = ["fire", "smoke"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize a YOLO/Roboflow export for BBIYONG")
    parser.add_argument("--source", required=True, type=Path, help="YOLO export ZIP or extracted directory")
    parser.add_argument("--destination", required=True, type=Path, help="Output dataset directory")
    parser.add_argument("--force", action="store_true", help="Replace an existing destination")
    return parser.parse_args()


def safe_extract(archive: Path, destination: Path) -> None:
    root = destination.resolve()
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            target = (root / member.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"Unsafe ZIP member path: {member.filename}")
        source.extractall(root)


def find_yaml(root: Path) -> Path:
    candidates = sorted((*root.rglob("data.yaml"), *root.rglob("data.yml")))
    if len(candidates) != 1:
        raise ValueError(f"Expected exactly one data.yaml/data.yml, found {len(candidates)}")
    return candidates[0]


def resolve_source_split(yaml_path: Path, data: dict, split: str) -> Path | None:
    value = data.get(split)
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(f"Only directory-based splits are supported; got {split}={value!r}")
    root_value = Path(str(data.get("path", ".")))
    root = root_value if root_value.is_absolute() else (yaml_path.parent / root_value)
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate.resolve()
    resolved = (root / candidate).resolve()
    if resolved.exists():
        return resolved

    # Roboflow ZIP exports commonly use ../train/images even though data.yaml
    # and train/ are siblings inside the extracted archive.
    trimmed_parts = list(candidate.parts)
    while trimmed_parts and trimmed_parts[0] == "..":
        trimmed_parts.pop(0)
    fallback = (yaml_path.parent / Path(*trimmed_parts)).resolve()
    return fallback if fallback.exists() else resolved


def source_label(image: Path, image_root: Path) -> Path:
    parts = list(image_root.parts)
    lowered = [part.lower() for part in parts]
    if "images" not in lowered:
        raise ValueError(f"Split image directory must contain an 'images' component: {image_root}")
    index = len(lowered) - 1 - lowered[::-1].index("images")
    parts[index] = "labels"
    label_root = Path(*parts)
    return (label_root / image.relative_to(image_root)).with_suffix(".txt")


def copy_label(source: Path, destination: Path, class_map: dict[int, int]) -> None:
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
        except ValueError as exc:
            raise ValueError(f"{source}:{line_number}: invalid class ID {fields[0]!r}") from exc
        if source_class not in class_map:
            raise ValueError(f"{source}:{line_number}: unknown class ID {source_class}")
        fields[0] = str(class_map[source_class])
        output_lines.append(" ".join(fields))
    destination.write_text("\n".join(output_lines) + ("\n" if output_lines else ""), encoding="utf-8")


def copy_split(
    source_images: Path,
    destination: Path,
    split: str,
    class_map: dict[int, int],
) -> None:
    if not source_images.is_dir():
        raise ValueError(f"Source {split} image directory does not exist: {source_images}")
    destination_images = destination / "images" / split
    destination_labels = destination / "labels" / split
    for image in sorted(path for path in source_images.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES):
        relative = image.relative_to(source_images)
        target_image = destination_images / relative
        target_image.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(image, target_image)
        label = source_label(image, source_images)
        if label.exists():
            target_label = (destination_labels / relative).with_suffix(".txt")
            target_label.parent.mkdir(parents=True, exist_ok=True)
            copy_label(label, target_label, class_map)


def prepare(source: Path, destination: Path, force: bool) -> Path:
    source = source.resolve()
    destination = destination.resolve()
    if destination.exists():
        if not force:
            raise FileExistsError(f"Destination already exists: {destination} (use --force to replace it)")
        shutil.rmtree(destination)

    with tempfile.TemporaryDirectory(prefix="bbiyong-dataset-") as temp_dir:
        if source.is_file() and source.suffix.lower() == ".zip":
            extracted = Path(temp_dir)
            safe_extract(source, extracted)
            source_root = extracted
        elif source.is_dir():
            source_root = source
        else:
            raise FileNotFoundError(f"Source must be a ZIP or directory: {source}")

        source_yaml = find_yaml(source_root)
        with source_yaml.open("r", encoding="utf-8") as stream:
            source_data = yaml.safe_load(stream) or {}
        names = class_names(source_data)
        if len(names) != len(EXPECTED_NAMES) or set(names) != set(EXPECTED_NAMES):
            raise ValueError(f"Expected exactly the classes {EXPECTED_NAMES}, got {names}")
        class_map = {source_id: EXPECTED_NAMES.index(name) for source_id, name in enumerate(names)}

        for split in ALL_SPLITS:
            source_images = resolve_source_split(source_yaml, source_data, split)
            if source_images is not None:
                copy_split(source_images, destination, split, class_map)

    destination.mkdir(parents=True, exist_ok=True)
    output_yaml = destination / "data.yaml"
    output_data = {
        "path": destination.as_posix(),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test" if (destination / "images" / "test").is_dir() else None,
        "names": {0: "fire", 1: "smoke"},
    }
    with output_yaml.open("w", encoding="utf-8") as stream:
        yaml.safe_dump(output_data, stream, sort_keys=False, allow_unicode=True)
    return output_yaml


def main() -> int:
    args = parse_args()
    try:
        output_yaml = prepare(args.source, args.destination, args.force)
        report = validate_dataset(output_yaml)
        print_report(report)
        if not report.ok:
            return 1
        print(f"Prepared dataset: {output_yaml}")
        return 0
    except (FileNotFoundError, FileExistsError, ValueError, zipfile.BadZipFile) as exc:
        print(f"ERROR: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
