from __future__ import annotations

import argparse
import csv
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
import yaml
from ultralytics import YOLO

from camera_inference import normalized_names, resolve_device, resolve_model
from dataset_utils import print_report, validate_dataset
from postprocessing import Detection, box_iou, detections_from_result


AI_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_NAMES = ["smoke", "fire"]


@dataclass(frozen=True)
class GroundTruth:
    class_id: int
    xyxy: tuple[float, float, float, float]


@dataclass(frozen=True)
class ImageRecord:
    predictions: tuple[Detection, ...]
    targets: tuple[GroundTruth, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Tune YOLO11n class thresholds on validation data only"
    )
    parser.add_argument(
        "--model",
        default=(
            "artifacts/runs/dfire-v1-640-b56-seed42/"
            "yolo11n-2/weights/best.pt"
        ),
    )
    parser.add_argument("--data", type=Path, default=AI_ROOT / "data/fire_smoke/data.yaml")
    parser.add_argument("--split", choices=("val",), default="val")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--candidate-conf", type=float, default=0.01)
    parser.add_argument("--nms-iou", type=float, default=0.7)
    parser.add_argument("--match-iou", type=float, default=0.5)
    parser.add_argument("--max-det", type=int, default=300)
    parser.add_argument("--threshold-min", type=float, default=0.05)
    parser.add_argument("--threshold-max", type=float, default=0.90)
    parser.add_argument("--threshold-step", type=float, default=0.01)
    parser.add_argument("--smoke-beta", type=float, default=2.0)
    parser.add_argument("--fire-beta", type=float, default=1.5)
    parser.add_argument("--min-precision", type=float, default=0.0)
    parser.add_argument("--min-recall", type=float, default=0.0)
    parser.add_argument("--temporal-window", type=int, default=5)
    parser.add_argument("--temporal-hits", type=int, default=3)
    parser.add_argument("--clear-after", type=int, default=3)
    parser.add_argument("--spatial-iou", type=float, default=0.0)
    parser.add_argument(
        "--output",
        type=Path,
        default=AI_ROOT / "artifacts/postprocessing/yolo11n-validation",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_roots(data_yaml: Path, split: str) -> tuple[Path, Path]:
    config = yaml.safe_load(data_yaml.read_text(encoding="utf-8"))
    root = Path(config.get("path", data_yaml.parent)).expanduser()
    if not root.is_absolute():
        root = (data_yaml.parent / root).resolve()
    split_path = Path(config[split])
    image_root = split_path if split_path.is_absolute() else root / split_path
    image_root = image_root.resolve()
    images_root = (root / "images").resolve()
    try:
        relative = image_root.relative_to(images_root)
    except ValueError as error:
        raise ValueError(f"Expected split under {images_root}, got {image_root}") from error
    return image_root, (root / "labels" / relative).resolve()


def load_targets(label_path: Path, width: int, height: int) -> tuple[GroundTruth, ...]:
    if not label_path.is_file():
        return ()
    targets = []
    for line_number, line in enumerate(label_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        values = line.split()
        if len(values) != 5:
            raise ValueError(f"Invalid label at {label_path}:{line_number}")
        class_id = int(values[0])
        center_x, center_y, box_width, box_height = map(float, values[1:])
        targets.append(
            GroundTruth(
                class_id=class_id,
                xyxy=(
                    (center_x - box_width / 2.0) * width,
                    (center_y - box_height / 2.0) * height,
                    (center_x + box_width / 2.0) * width,
                    (center_y + box_height / 2.0) * height,
                ),
            )
        )
    return tuple(targets)


def match_counts(
    records: list[ImageRecord], class_id: int, threshold: float, match_iou: float
) -> tuple[int, int, int]:
    true_positives = 0
    false_positives = 0
    false_negatives = 0
    for record in records:
        predictions = sorted(
            (
                item
                for item in record.predictions
                if item.class_id == class_id and item.confidence >= threshold
            ),
            key=lambda item: item.confidence,
            reverse=True,
        )
        targets = [item for item in record.targets if item.class_id == class_id]
        unmatched = set(range(len(targets)))
        for prediction in predictions:
            best_index = None
            best_iou = match_iou
            for target_index in unmatched:
                overlap = box_iou(prediction.xyxy, targets[target_index].xyxy)
                if overlap >= best_iou:
                    best_index = target_index
                    best_iou = overlap
            if best_index is None:
                false_positives += 1
            else:
                true_positives += 1
                unmatched.remove(best_index)
        false_negatives += len(unmatched)
    return true_positives, false_positives, false_negatives


def score_counts(tp: int, fp: int, fn: int, beta: float) -> dict[str, float | int]:
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    beta_squared = beta * beta
    denominator = beta_squared * precision + recall
    f_beta = (
        (1.0 + beta_squared) * precision * recall / denominator if denominator else 0.0
    )
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f_beta": f_beta,
    }


def threshold_values(start: float, stop: float, step: float) -> list[float]:
    count = int(round((stop - start) / step))
    return [round(start + index * step, 10) for index in range(count + 1)]


def choose_threshold(
    rows: list[dict[str, Any]], min_precision: float, min_recall: float
) -> tuple[dict[str, Any], bool]:
    feasible = [
        row
        for row in rows
        if row["precision"] >= min_precision and row["recall"] >= min_recall
    ]
    candidates = feasible or rows
    best = max(
        candidates,
        key=lambda row: (row["f_beta"], row["recall"], row["precision"], row["threshold"]),
    )
    return best, bool(feasible)


def collect_records(
    model: YOLO,
    names: list[str],
    image_root: Path,
    label_root: Path,
    args: argparse.Namespace,
    device: str,
) -> list[ImageRecord]:
    records = []
    results = model.predict(
        source=str(image_root),
        stream=True,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        workers=args.workers,
        conf=args.candidate_conf,
        iou=args.nms_iou,
        max_det=args.max_det,
        verbose=False,
    )
    for index, result in enumerate(results, start=1):
        image_path = Path(result.path).resolve()
        relative = image_path.relative_to(image_root)
        label_path = label_root / relative.with_suffix(".txt")
        height, width = result.orig_shape
        records.append(
            ImageRecord(
                predictions=tuple(detections_from_result(result, names)),
                targets=load_targets(label_path, width, height),
            )
        )
        if index % 500 == 0:
            print(f"[postprocess] collected {index} validation images", flush=True)
    return records


def main() -> int:
    args = parse_args()
    if not (
        0.0 <= args.candidate_conf <= args.threshold_min <= args.threshold_max <= 1.0
        and args.threshold_step > 0.0
        and 0.0 < args.nms_iou <= 1.0
        and 0.0 < args.match_iou <= 1.0
    ):
        raise SystemExit("Invalid confidence, threshold, or IoU range")
    if args.smoke_beta <= 0.0 or args.fire_beta <= 0.0:
        raise SystemExit("F-beta weights must be positive")
    if not 0.0 <= args.min_precision <= 1.0 or not 0.0 <= args.min_recall <= 1.0:
        raise SystemExit("Minimum precision and recall must be in [0, 1]")

    data_path = args.data.expanduser().resolve()
    report = validate_dataset(data_path)
    print_report(report)
    if not report.ok:
        raise SystemExit("Dataset validation failed")

    output = args.output.expanduser().resolve()
    if output.exists():
        raise SystemExit(f"Output already exists; choose a new directory: {output}")
    output.mkdir(parents=True)

    model_path = Path(resolve_model(args.model))
    device = resolve_device(args.device)
    if device != "cpu" and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested but is unavailable")
    model = YOLO(str(model_path))
    names = normalized_names(model)
    if names != EXPECTED_NAMES:
        raise SystemExit(f"Expected classes {EXPECTED_NAMES}, got {names}")

    image_root, label_root = resolve_roots(data_path, args.split)
    records = collect_records(model, names, image_root, label_root, args, device)
    thresholds = threshold_values(args.threshold_min, args.threshold_max, args.threshold_step)
    betas = {0: args.smoke_beta, 1: args.fire_beta}
    sweep_rows = []
    selections = {}
    constraints_met = {}

    for class_id, class_name in enumerate(names):
        class_rows = []
        for threshold in thresholds:
            counts = match_counts(records, class_id, threshold, args.match_iou)
            row = {
                "class_id": class_id,
                "class_name": class_name,
                "threshold": threshold,
                "beta": betas[class_id],
                **score_counts(*counts, beta=betas[class_id]),
            }
            class_rows.append(row)
            sweep_rows.append(row)
        selections[class_id], constraints_met[class_id] = choose_threshold(
            class_rows, args.min_precision, args.min_recall
        )

    with (output / "threshold_sweep.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=sweep_rows[0].keys())
        writer.writeheader()
        writer.writerows(sweep_rows)

    class_config = {}
    for class_id, selected in selections.items():
        threshold = float(selected["threshold"])
        class_config[str(class_id)] = {
            "name": names[class_id],
            "threshold": threshold,
            "hold_threshold": max(args.candidate_conf, round(threshold * 0.8, 4)),
            "validation": selected,
            "constraints_met": constraints_met[class_id],
        }

    config = {
        "version": 1,
        "candidate_confidence": args.candidate_conf,
        "nms_iou": args.nms_iou,
        "max_det": args.max_det,
        "classes": class_config,
        "temporal": {
            "window": args.temporal_window,
            "min_hits": args.temporal_hits,
            "clear_after": args.clear_after,
            "spatial_iou": args.spatial_iou,
        },
        "metadata": {
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "model": str(model_path.resolve()),
            "model_sha256": sha256(model_path),
            "dataset": str(data_path),
            "dataset_yaml_sha256": sha256(data_path),
            "split": args.split,
            "images": len(records),
            "match_iou": args.match_iou,
            "selection": "maximum class-specific F-beta subject to optional constraints",
            "temporal_policy_tuned": False,
        },
    }
    config_path = output / "postprocess_config.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

    print("\nclass   threshold  precision  recall  F-beta  constraints", flush=True)
    for class_id, selected in selections.items():
        print(
            f"{names[class_id]:<7} {selected['threshold']:>9.3f} "
            f"{selected['precision']:>10.4f} {selected['recall']:>7.4f} "
            f"{selected['f_beta']:>7.4f} {constraints_met[class_id]}",
            flush=True,
        )
    print(f"[postprocess] config={config_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
