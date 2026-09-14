from __future__ import annotations

import argparse
import json
from pathlib import Path

from ultralytics import YOLO

from camera_inference import FIRE_SMOKE_NAMES, normalized_names, resolve_device, resolve_model
from cascade import CascadeConfig, fuse_cascade
from evaluate_cascade_comparison import (
    Prediction,
    evaluate_predictions,
    list_images,
    resolve_split_roots,
    to_predictions,
    tune_class_thresholds,
)
from evaluate_tta_consensus import consensus
from postprocessing import Detection, detections_from_result
from tune_tta_consensus import load_cache


AI_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate YOLO11n with cached YOLO11s TTA consensus as the cascade verifier"
    )
    parser.add_argument("--tta-cache", type=Path, required=True)
    parser.add_argument(
        "--model", default="artifacts/runs/dfire-v1-640-b56-seed42/yolo11n-2/weights/best.pt"
    )
    parser.add_argument("--data", type=Path, default=AI_ROOT / "data/fire_smoke/data.yaml")
    parser.add_argument("--split", choices=("val", "test"), default="val")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--candidate-conf", type=float, default=0.001)
    parser.add_argument("--nms-iou", type=float, default=0.70)
    parser.add_argument("--max-det", type=int, default=300)
    parser.add_argument("--min-votes", type=int, default=4)
    parser.add_argument("--tta-agreement-iou", type=float, default=0.60)
    parser.add_argument("--high-conf-smoke", type=float, default=0.65)
    parser.add_argument("--high-conf-fire", type=float, default=0.75)
    parser.add_argument("--verify-low", type=float, default=0.15)
    parser.add_argument("--verify-high", type=float, default=0.60)
    parser.add_argument("--primary-conf", type=float, default=0.35)
    parser.add_argument("--cascade-agreement-iou", type=float, default=0.50)
    parser.add_argument("--verifier-only-conf", type=float, default=0.70)
    parser.add_argument("--final-nms-iou", type=float, default=0.35)
    parser.add_argument("--threshold-min", type=float, default=0.05)
    parser.add_argument("--threshold-max", type=float, default=0.90)
    parser.add_argument("--threshold-step", type=float, default=0.01)
    parser.add_argument("--smoke-beta", type=float, default=2.0)
    parser.add_argument("--fire-beta", type=float, default=1.5)
    parser.add_argument("--min-precision", type=float, default=0.80)
    parser.add_argument("--min-recall", type=float, default=0.80)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.output.exists():
        raise SystemExit(f"Output already exists: {args.output}")
    if not args.tta_cache.is_file():
        raise SystemExit(f"TTA cache not found: {args.tta_cache}")
    if args.batch < 1 or args.imgsz < 32:
        raise SystemExit("imgsz must be >= 32 and batch must be positive")

    tta_by_image, targets = load_cache(args.tta_cache)
    image_root, _ = resolve_split_roots(args.data.resolve(), args.split)
    image_paths = list_images(image_root)
    if len(image_paths) != len(tta_by_image):
        raise SystemExit(
            f"Cache/image mismatch: cache has {len(tta_by_image)} images, split has {len(image_paths)}"
        )
    model = YOLO(resolve_model(args.model))
    names = normalized_names(model)
    if names != FIRE_SMOKE_NAMES:
        raise SystemExit("Checkpoint must use classes 0: smoke, 1: fire")
    tta_settings = argparse.Namespace(
        min_votes=args.min_votes,
        agreement_iou=args.tta_agreement_iou,
        high_conf_smoke=args.high_conf_smoke,
        high_conf_fire=args.high_conf_fire,
    )
    cascade_settings = CascadeConfig(
        verify_low=args.verify_low,
        verify_high=args.verify_high,
        primary_confidence=args.primary_conf,
        agreement_iou=args.cascade_agreement_iou,
        verifier_only_confidence=args.verifier_only_conf,
        final_nms_iou=args.final_nms_iou,
        verifier_interval=1,
    )
    cascade_settings.validate()

    baseline_predictions: list[Prediction] = []
    cascade_predictions: list[Prediction] = []
    primary_ms = 0.0
    for batch_start in range(0, len(image_paths), args.batch):
        batch_paths = image_paths[batch_start : batch_start + args.batch]
        results = model.predict(
            source=[str(path) for path in batch_paths],
            imgsz=args.imgsz,
            conf=args.candidate_conf,
            iou=args.nms_iou,
            max_det=args.max_det,
            batch=len(batch_paths),
            device=resolve_device(args.device),
            verbose=False,
        )
        primary_ms += sum(float(result.speed.get("inference", 0.0)) for result in results)
        for local_index, result in enumerate(results):
            image_id = batch_start + local_index
            primary = detections_from_result(result, names)
            verifier = consensus(tta_by_image[image_id], tta_settings)
            baseline_predictions.extend(to_predictions(image_id, primary))
            cascade_predictions.extend(
                to_predictions(image_id, fuse_cascade(primary, verifier, cascade_settings))
            )
        done = min(batch_start + len(batch_paths), len(image_paths))
        print(f"[tta-cascade] {done}/{len(image_paths)} images", flush=True)

    baseline = evaluate_predictions(baseline_predictions, targets, FIRE_SMOKE_NAMES, 0.25)
    cascade = evaluate_predictions(cascade_predictions, targets, FIRE_SMOKE_NAMES, 0.25)
    tuning = tune_class_thresholds(cascade_predictions, targets, FIRE_SMOKE_NAMES, args)
    args.output.mkdir(parents=True)
    settings = {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()}
    (args.output / "comparison.json").write_text(
        json.dumps(
            {
                "settings": settings,
                "metrics": {"yolo11n": baseline, "tta_cascade": cascade},
                "threshold_tuning": tuning,
                "primary_inference_ms_per_image": primary_ms / len(image_paths),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print("\npipeline      precision  recall    F1")
    for name, report in (("yolo11n", baseline), ("tta_cascade", cascade)):
        aggregate = report["aggregate"]
        print(f"{name:<13} {aggregate['precision']:.4f}     {aggregate['recall']:.4f}    {aggregate['f1']:.4f}")
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
