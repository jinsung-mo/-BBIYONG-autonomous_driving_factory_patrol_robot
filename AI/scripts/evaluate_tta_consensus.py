from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

from camera_inference import FIRE_SMOKE_NAMES, normalized_names, resolve_device, resolve_model
from evaluate_cascade_comparison import (
    Prediction,
    evaluate_predictions,
    label_path_for,
    list_images,
    load_targets,
    resolve_split_roots,
    to_predictions,
    tune_class_thresholds,
)
from postprocessing import Detection, box_iou, detections_from_result


AI_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate four-view YOLO TTA consensus on labeled images")
    parser.add_argument("--model", default="artifacts/runs/dfire-v1-640-b56-seed42/yolo11s/weights/best.pt")
    parser.add_argument("--data", type=Path, default=AI_ROOT / "data/fire_smoke/data.yaml")
    parser.add_argument("--split", choices=("val", "test"), default="val")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--candidate-conf", type=float, default=0.01)
    parser.add_argument("--nms-iou", type=float, default=0.70)
    parser.add_argument("--min-votes", type=int, default=3)
    parser.add_argument("--agreement-iou", type=float, default=0.50)
    parser.add_argument("--high-conf-smoke", type=float, default=0.65)
    parser.add_argument("--high-conf-fire", type=float, default=0.60)
    parser.add_argument("--dark-gamma", type=float, default=1.20)
    parser.add_argument("--bright-gamma", type=float, default=0.80)
    parser.add_argument("--threshold-min", type=float, default=0.05)
    parser.add_argument("--threshold-max", type=float, default=0.90)
    parser.add_argument("--threshold-step", type=float, default=0.01)
    parser.add_argument("--smoke-beta", type=float, default=2.0)
    parser.add_argument("--fire-beta", type=float, default=1.5)
    parser.add_argument("--min-precision", type=float, default=0.0)
    parser.add_argument("--min-recall", type=float, default=0.0)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def gamma(image: np.ndarray, value: float) -> np.ndarray:
    return np.clip(((image.astype(np.float32) / 255.0) ** value) * 255.0, 0, 255).astype(np.uint8)


def views(image: np.ndarray, args: argparse.Namespace) -> list[tuple[str, np.ndarray]]:
    return [("original", image), ("flip", cv2.flip(image, 1)), ("dark", gamma(image, args.dark_gamma)), ("bright", gamma(image, args.bright_gamma))]


def restore_flip(detection: Detection, width: int) -> Detection:
    left, top, right, bottom = detection.xyxy
    return Detection(detection.class_id, detection.class_name, detection.confidence, (width - right, top, width - left, bottom))


def consensus(items: list[tuple[int, Detection]], args: argparse.Namespace) -> tuple[Detection, ...]:
    clusters: list[list[tuple[int, Detection]]] = []
    for view_id, item in sorted(items, key=lambda value: value[1].confidence, reverse=True):
        for cluster in clusters:
            anchor = cluster[0][1]
            if item.class_id == anchor.class_id and box_iou(item.xyxy, anchor.xyxy) >= args.agreement_iou:
                cluster.append((view_id, item))
                break
        else:
            clusters.append([(view_id, item)])
    accepted = []
    for cluster in clusters:
        best = max((item for _, item in cluster), key=lambda item: item.confidence)
        high = args.high_conf_smoke if best.class_id == 0 else args.high_conf_fire
        if best.confidence >= high or len({view_id for view_id, _ in cluster}) >= args.min_votes:
            accepted.append(best)
    return tuple(accepted)


def main() -> int:
    args = parse_args()
    if args.output.exists():
        raise SystemExit(f"Output already exists: {args.output}")
    if not 1 <= args.min_votes <= 4 or not 0 <= args.agreement_iou <= 1:
        raise SystemExit("Invalid vote count or agreement IoU")
    model = YOLO(resolve_model(args.model))
    names = normalized_names(model)
    if names != FIRE_SMOKE_NAMES:
        raise SystemExit("Checkpoint must use classes 0: smoke, 1: fire")
    image_root, label_root = resolve_split_roots(args.data.resolve(), args.split)
    image_paths = list_images(image_root)
    predictions: list[Prediction] = []
    targets = []
    raw_views = []
    device = resolve_device(args.device)
    for image_id, image_path in enumerate(image_paths):
        image = cv2.imread(str(image_path))
        if image is None:
            raise RuntimeError(f"Could not read {image_path}")
        height, width = image.shape[:2]
        targets.extend(load_targets(label_path_for(image_path, image_root, label_root), image_id, width, height))
        detections = []
        for view_id, (name, view) in enumerate(views(image, args)):
            result = model.predict(source=view, imgsz=args.imgsz, conf=args.candidate_conf, iou=args.nms_iou, device=device, verbose=False)[0]
            for item in detections_from_result(result, names):
                detections.append((view_id, restore_flip(item, width) if name == "flip" else item))
        raw_views.append(
            {
                "image_id": image_id,
                "detections": [
                    {
                        "view_id": view_id,
                        "class_id": item.class_id,
                        "class_name": item.class_name,
                        "confidence": item.confidence,
                        "xyxy": item.xyxy,
                    }
                    for view_id, item in detections
                ],
            }
        )
        predictions.extend(to_predictions(image_id, consensus(detections, args)))
        if (image_id + 1) % 100 == 0 or image_id + 1 == len(image_paths):
            print(f"[tta] {image_id + 1}/{len(image_paths)} images", flush=True)
    report = evaluate_predictions(predictions, targets, FIRE_SMOKE_NAMES, 0.0)
    tuning = tune_class_thresholds(predictions, targets, FIRE_SMOKE_NAMES, args)
    args.output.mkdir(parents=True)
    settings = {
        key: str(value) if isinstance(value, Path) else value
        for key, value in vars(args).items()
    }
    (args.output / "comparison.json").write_text(
        json.dumps({"settings": settings, "metrics": report, "threshold_tuning": tuning}, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output / "raw_views.json").write_text(
        json.dumps({"raw_views": raw_views, "targets": [target.__dict__ for target in targets]}) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["per_class"], indent=2))
    print("\nclass   threshold  precision  recall  F1      F-beta  constraints")
    for item in tuning["classes"]:
        selected = item["selected"]
        print(
            f"{item['class_name']:<7} {selected['threshold']:>9.3f} "
            f"{selected['precision']:>7.4f} {selected['recall']:>7.4f} "
            f"{selected['f1']:>7.4f} {selected['f_beta']:>7.4f} "
            f"{item['constraints_met']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
