from __future__ import annotations

import argparse
import csv
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import yaml
from ultralytics import YOLO

from camera_inference import FIRE_SMOKE_NAMES, normalized_names, resolve_device, resolve_model
from cascade import CascadeConfig, fuse_cascade, should_run_verifier
from dataset_utils import print_report, validate_dataset
from postprocessing import Detection, box_iou, detections_from_result


AI_ROOT = Path(__file__).resolve().parents[1]
IMAGE_SUFFIXES = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
IOU_THRESHOLDS = tuple(round(0.50 + index * 0.05, 2) for index in range(10))


@dataclass(frozen=True)
class Prediction:
    image_id: int
    class_id: int
    confidence: float
    xyxy: tuple[float, float, float, float]


@dataclass(frozen=True)
class Target:
    image_id: int
    class_id: int
    xyxy: tuple[float, float, float, float]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare YOLO11n with the YOLO11n-to-YOLO11s cascade on labeled images"
    )
    parser.add_argument(
        "--model",
        default="artifacts/runs/dfire-v1-640-b56-seed42/yolo11n-2/weights/best.pt",
    )
    parser.add_argument(
        "--verifier-model",
        default="artifacts/runs/dfire-v1-640-b56-seed42/yolo11s/weights/best.pt",
    )
    parser.add_argument("--data", type=Path, default=AI_ROOT / "data/fire_smoke/data.yaml")
    parser.add_argument("--split", choices=("val", "test"), default="test")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--candidate-conf", type=float, default=0.001)
    parser.add_argument("--score-threshold", type=float, default=0.25)
    parser.add_argument("--nms-iou", type=float, default=0.70)
    parser.add_argument("--max-det", type=int, default=300)
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--verify-low", type=float, default=0.15)
    parser.add_argument("--verify-high", type=float, default=0.60)
    parser.add_argument("--primary-conf", type=float, default=0.25)
    parser.add_argument("--agreement-iou", type=float, default=0.50)
    parser.add_argument("--verifier-only-conf", type=float, default=0.75)
    parser.add_argument("--final-nms-iou", type=float, default=0.50)
    parser.add_argument("--verifier-interval", type=int, default=5)
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Evaluate only the first N images for a smoke test; 0 evaluates the full split",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=AI_ROOT / "artifacts/evaluations/cascade-vs-yolo11n",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_split_roots(data_yaml: Path, split: str) -> tuple[Path, Path]:
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


def list_images(image_root: Path) -> list[Path]:
    return sorted(
        path
        for path in image_root.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )


def label_path_for(image_path: Path, image_root: Path, label_root: Path) -> Path:
    return (label_root / image_path.relative_to(image_root)).with_suffix(".txt")


def load_targets(
    label_path: Path, image_id: int, width: int, height: int
) -> tuple[Target, ...]:
    if not label_path.is_file():
        return ()
    targets = []
    for line_number, raw_line in enumerate(
        label_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line.strip():
            continue
        values = raw_line.split()
        if len(values) != 5:
            raise ValueError(f"Invalid YOLO label at {label_path}:{line_number}")
        class_id = int(values[0])
        center_x, center_y, box_width, box_height = map(float, values[1:])
        targets.append(
            Target(
                image_id=image_id,
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


def to_predictions(image_id: int, detections: Iterable[Detection]) -> list[Prediction]:
    return [
        Prediction(image_id, item.class_id, item.confidence, item.xyxy) for item in detections
    ]


def match_predictions(
    predictions: Iterable[Prediction],
    targets: Iterable[Target],
    *,
    class_id: int,
    iou_threshold: float,
    score_threshold: float = 0.0,
) -> tuple[list[bool], int]:
    class_predictions = sorted(
        (
            item
            for item in predictions
            if item.class_id == class_id and item.confidence >= score_threshold
        ),
        key=lambda item: item.confidence,
        reverse=True,
    )
    targets_by_image: dict[int, list[Target]] = {}
    for target in targets:
        if target.class_id == class_id:
            targets_by_image.setdefault(target.image_id, []).append(target)

    matched: set[tuple[int, int]] = set()
    true_positives = []
    for prediction in class_predictions:
        best_index = None
        best_iou = iou_threshold
        for target_index, target in enumerate(targets_by_image.get(prediction.image_id, [])):
            key = (prediction.image_id, target_index)
            if key in matched:
                continue
            overlap = box_iou(prediction.xyxy, target.xyxy)
            if overlap >= best_iou:
                best_iou = overlap
                best_index = target_index
        true_positives.append(best_index is not None)
        if best_index is not None:
            matched.add((prediction.image_id, best_index))
    return true_positives, sum(len(items) for items in targets_by_image.values())


def average_precision(true_positives: list[bool], target_count: int) -> float:
    if target_count == 0:
        return 0.0
    cumulative_tp = 0
    precisions = []
    recalls = []
    for rank, is_true_positive in enumerate(true_positives, start=1):
        cumulative_tp += int(is_true_positive)
        precisions.append(cumulative_tp / rank)
        recalls.append(cumulative_tp / target_count)
    if not precisions:
        return 0.0
    precision_envelope = precisions[:]
    for index in range(len(precision_envelope) - 2, -1, -1):
        precision_envelope[index] = max(precision_envelope[index], precision_envelope[index + 1])
    samples = []
    for recall_level in (index / 100.0 for index in range(101)):
        samples.append(
            max(
                (
                    precision
                    for recall, precision in zip(recalls, precision_envelope, strict=True)
                    if recall >= recall_level
                ),
                default=0.0,
            )
        )
    return sum(samples) / len(samples)


def safe_divide(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def evaluate_predictions(
    predictions: list[Prediction],
    targets: list[Target],
    class_names: list[str],
    score_threshold: float,
) -> dict:
    per_class = []
    aggregate_tp = 0
    aggregate_fp = 0
    aggregate_targets = 0
    all_average_precisions = []
    map50_values = []

    for class_id, class_name in enumerate(class_names):
        operating_matches, target_count = match_predictions(
            predictions,
            targets,
            class_id=class_id,
            iou_threshold=0.50,
            score_threshold=score_threshold,
        )
        true_positives = sum(operating_matches)
        false_positives = len(operating_matches) - true_positives
        false_negatives = target_count - true_positives
        precision = safe_divide(true_positives, true_positives + false_positives)
        recall = safe_divide(true_positives, target_count)
        f1 = safe_divide(2 * precision * recall, precision + recall)

        class_aps = []
        for iou_threshold in IOU_THRESHOLDS:
            matches, ap_target_count = match_predictions(
                predictions,
                targets,
                class_id=class_id,
                iou_threshold=iou_threshold,
            )
            class_aps.append(average_precision(matches, ap_target_count))
        map50_values.append(class_aps[0])
        all_average_precisions.extend(class_aps)
        per_class.append(
            {
                "class_id": class_id,
                "class_name": class_name,
                "targets": target_count,
                "true_positives": true_positives,
                "false_positives": false_positives,
                "false_negatives": false_negatives,
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "map50": class_aps[0],
                "map50_95": sum(class_aps) / len(class_aps),
                "ap_by_iou": {
                    f"{threshold:.2f}": value
                    for threshold, value in zip(IOU_THRESHOLDS, class_aps, strict=True)
                },
            }
        )
        aggregate_tp += true_positives
        aggregate_fp += false_positives
        aggregate_targets += target_count

    aggregate_precision = safe_divide(aggregate_tp, aggregate_tp + aggregate_fp)
    aggregate_recall = safe_divide(aggregate_tp, aggregate_targets)
    return {
        "score_threshold": score_threshold,
        "aggregate": {
            "targets": aggregate_targets,
            "true_positives": aggregate_tp,
            "false_positives": aggregate_fp,
            "false_negatives": aggregate_targets - aggregate_tp,
            "precision": aggregate_precision,
            "recall": aggregate_recall,
            "f1": safe_divide(
                2 * aggregate_precision * aggregate_recall,
                aggregate_precision + aggregate_recall,
            ),
            "map50": sum(map50_values) / len(map50_values),
            "map50_95": sum(all_average_precisions) / len(all_average_precisions),
        },
        "per_class": per_class,
    }


def write_csv(reports: dict[str, dict], output: Path) -> None:
    fields = (
        "pipeline",
        "scope",
        "class_id",
        "class_name",
        "targets",
        "true_positives",
        "false_positives",
        "false_negatives",
        "precision",
        "recall",
        "f1",
        "map50",
        "map50_95",
        "inference_ms_per_image",
        "verifier_invocation_rate",
    )
    with output.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for pipeline, report in reports.items():
            common = {
                "pipeline": pipeline,
                "inference_ms_per_image": report["timing"]["inference_ms_per_image"],
                "verifier_invocation_rate": report["timing"]["verifier_invocation_rate"],
            }
            writer.writerow(
                {
                    **common,
                    "scope": "all",
                    "class_id": "",
                    "class_name": "all",
                    **report["metrics"]["aggregate"],
                }
            )
            for item in report["metrics"]["per_class"]:
                writer.writerow({**common, "scope": "class", **item})


def validate_args(args: argparse.Namespace) -> None:
    if args.imgsz < 32 or args.batch < 1 or args.max_det < 1 or args.limit < 0:
        raise ValueError("imgsz must be >= 32; batch/max-det positive; limit non-negative")
    for name in (
        "candidate_conf",
        "score_threshold",
        "verify_low",
        "verify_high",
        "primary_conf",
        "agreement_iou",
        "verifier_only_conf",
        "final_nms_iou",
    ):
        if not 0.0 <= getattr(args, name) <= 1.0:
            raise ValueError(f"--{name.replace('_', '-')} must be in [0, 1]")
    if not 0.0 < args.nms_iou <= 1.0:
        raise ValueError("--nms-iou must be in (0, 1]")


def main() -> int:
    args = parse_args()
    try:
        validate_args(args)
        data_path = args.data.expanduser().resolve()
        if not data_path.is_file():
            raise FileNotFoundError(f"Dataset YAML does not exist: {data_path}")
        primary_path = Path(resolve_model(args.model))
        verifier_path = Path(resolve_model(args.verifier_model))
        output = args.output.expanduser().resolve()
        if output.exists():
            raise FileExistsError(f"Output already exists; choose a new --output: {output}")
        device = resolve_device(args.device)
        if args.half and device == "cpu":
            raise ValueError("--half requires a CUDA device")

        report = validate_dataset(data_path)
        print_report(report)
        if not report.ok:
            raise ValueError("Dataset validation failed")
        image_root, label_root = resolve_split_roots(data_path, args.split)
        image_paths = list_images(image_root)
        if args.limit:
            image_paths = image_paths[: args.limit]
        if not image_paths:
            raise ValueError(f"No images found in {image_root}")

        primary_model = YOLO(str(primary_path))
        verifier_model = YOLO(str(verifier_path))
        primary_names = normalized_names(primary_model)
        verifier_names = normalized_names(verifier_model)
        if primary_names != FIRE_SMOKE_NAMES or verifier_names != FIRE_SMOKE_NAMES:
            raise ValueError("Both checkpoints must use classes 0: smoke, 1: fire")
        cascade_config = CascadeConfig(
            verify_low=args.verify_low,
            verify_high=args.verify_high,
            primary_confidence=args.primary_conf,
            agreement_iou=args.agreement_iou,
            verifier_only_confidence=args.verifier_only_conf,
            final_nms_iou=args.final_nms_iou,
            verifier_interval=args.verifier_interval,
        )
        cascade_config.validate()
    except (FileExistsError, FileNotFoundError, KeyError, RuntimeError, ValueError) as error:
        print(f"ERROR: {error}")
        return 2

    output.mkdir(parents=True)
    precision_args = {"half": True} if args.half else {}
    baseline_predictions: list[Prediction] = []
    cascade_predictions: list[Prediction] = []
    targets: list[Target] = []
    primary_inference_ms = 0.0
    verifier_inference_ms = 0.0
    verifier_invocations = 0

    print(
        f"[cascade-eval] split={args.split} images={len(image_paths)} device={device} "
        f"verifier_interval={args.verifier_interval}",
        flush=True,
    )
    for batch_start in range(0, len(image_paths), args.batch):
        batch_paths = image_paths[batch_start : batch_start + args.batch]
        primary_results = primary_model.predict(
            source=[str(path) for path in batch_paths],
            imgsz=args.imgsz,
            conf=args.candidate_conf,
            iou=args.nms_iou,
            max_det=args.max_det,
            batch=len(batch_paths),
            device=device,
            verbose=False,
            **precision_args,
        )
        primary_detections = [
            detections_from_result(result, primary_names) for result in primary_results
        ]
        primary_inference_ms += sum(
            float(result.speed.get("inference", 0.0)) for result in primary_results
        )

        verifier_local_indices = [
            local_index
            for local_index, detections in enumerate(primary_detections)
            if should_run_verifier(
                detections, batch_start + local_index + 1, cascade_config
            )
        ]
        verifier_by_local_index: dict[int, list[Detection]] = {}
        if verifier_local_indices:
            verifier_results = verifier_model.predict(
                source=[str(batch_paths[index]) for index in verifier_local_indices],
                imgsz=args.imgsz,
                conf=min(args.verify_low, args.verifier_only_conf),
                iou=args.nms_iou,
                max_det=args.max_det,
                batch=len(verifier_local_indices),
                device=device,
                verbose=False,
                **precision_args,
            )
            verifier_invocations += len(verifier_results)
            verifier_inference_ms += sum(
                float(result.speed.get("inference", 0.0)) for result in verifier_results
            )
            verifier_by_local_index = {
                local_index: detections_from_result(result, verifier_names)
                for local_index, result in zip(
                    verifier_local_indices, verifier_results, strict=True
                )
            }

        for local_index, (image_path, result, primary) in enumerate(
            zip(batch_paths, primary_results, primary_detections, strict=True)
        ):
            image_id = batch_start + local_index
            height, width = result.orig_shape
            targets.extend(
                load_targets(
                    label_path_for(image_path, image_root, label_root),
                    image_id,
                    width,
                    height,
                )
            )
            baseline_predictions.extend(to_predictions(image_id, primary))
            fused = fuse_cascade(
                primary, verifier_by_local_index.get(local_index), cascade_config
            )
            cascade_predictions.extend(to_predictions(image_id, fused))

        completed = min(batch_start + len(batch_paths), len(image_paths))
        print(f"[cascade-eval] {completed}/{len(image_paths)} images", flush=True)

    image_count = len(image_paths)
    baseline_metrics = evaluate_predictions(
        baseline_predictions, targets, FIRE_SMOKE_NAMES, args.score_threshold
    )
    cascade_metrics = evaluate_predictions(
        cascade_predictions, targets, FIRE_SMOKE_NAMES, args.score_threshold
    )
    verifier_rate = verifier_invocations / image_count
    reports = {
        "yolo11n": {
            "metrics": baseline_metrics,
            "prediction_count": len(baseline_predictions),
            "timing": {
                "primary_inference_ms_per_image": primary_inference_ms / image_count,
                "verifier_inference_ms_per_image": 0.0,
                "inference_ms_per_image": primary_inference_ms / image_count,
                "verifier_invocations": 0,
                "verifier_invocation_rate": 0.0,
            },
        },
        "cascade": {
            "metrics": cascade_metrics,
            "prediction_count": len(cascade_predictions),
            "timing": {
                "primary_inference_ms_per_image": primary_inference_ms / image_count,
                "verifier_inference_ms_per_invocation": safe_divide(
                    verifier_inference_ms, verifier_invocations
                ),
                "verifier_inference_ms_per_image": verifier_inference_ms / image_count,
                "inference_ms_per_image": (primary_inference_ms + verifier_inference_ms)
                / image_count,
                "verifier_invocations": verifier_invocations,
                "verifier_invocation_rate": verifier_rate,
            },
        },
    }
    comparison = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": str(data_path),
        "dataset_sha256": sha256(data_path),
        "split": args.split,
        "images": image_count,
        "limited_evaluation": bool(args.limit),
        "targets": len(targets),
        "checkpoints": {
            "yolo11n": {"path": str(primary_path), "sha256": sha256(primary_path)},
            "yolo11s_verifier": {
                "path": str(verifier_path),
                "sha256": sha256(verifier_path),
            },
        },
        "settings": {
            "imgsz": args.imgsz,
            "batch": args.batch,
            "device": device,
            "half": args.half,
            "candidate_conf": args.candidate_conf,
            "score_threshold": args.score_threshold,
            "nms_iou": args.nms_iou,
            "max_det": args.max_det,
            "iou_thresholds": IOU_THRESHOLDS,
            "cascade": asdict(cascade_config),
            "note": (
                "Images are evaluated independently without temporal alarm state. "
                "Periodic verifier scheduling follows sorted image order."
            ),
        },
        "pipelines": reports,
    }
    comparison_path = output / "comparison.json"
    comparison_path.write_text(
        json.dumps(comparison, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    write_csv(reports, output / "comparison.csv")

    print("\npipeline      precision  recall    F1      mAP50   mAP50-95  infer_ms")
    for name, pipeline in reports.items():
        metrics = pipeline["metrics"]["aggregate"]
        print(
            f"{name:<13} {metrics['precision']:<10.4f} {metrics['recall']:<9.4f} "
            f"{metrics['f1']:<7.4f} {metrics['map50']:<7.4f} "
            f"{metrics['map50_95']:<10.4f} "
            f"{pipeline['timing']['inference_ms_per_image']:.3f}"
        )
    print(f"verifier_invocation_rate={verifier_rate:.2%}")
    print(f"[cascade-eval] comparison={comparison_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
