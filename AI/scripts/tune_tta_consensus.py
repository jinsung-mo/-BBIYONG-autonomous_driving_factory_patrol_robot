from __future__ import annotations

import argparse
import json
from pathlib import Path

from camera_inference import FIRE_SMOKE_NAMES
from evaluate_cascade_comparison import Prediction, Target, tune_class_thresholds, to_predictions
from evaluate_tta_consensus import consensus
from postprocessing import Detection


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Tune TTA consensus parameters from cached raw detections; no model inference is run"
    )
    parser.add_argument("--cache", type=Path, required=True, help="raw_views.json made by evaluate_tta_consensus.py")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--min-precision", type=float, default=0.80)
    parser.add_argument("--min-recall", type=float, default=0.80)
    parser.add_argument("--threshold-min", type=float, default=0.05)
    parser.add_argument("--threshold-max", type=float, default=0.90)
    parser.add_argument("--threshold-step", type=float, default=0.05)
    parser.add_argument("--smoke-beta", type=float, default=2.0)
    parser.add_argument("--fire-beta", type=float, default=1.5)
    return parser.parse_args()


def load_cache(path: Path) -> tuple[list[list[tuple[int, Detection]]], list[Target]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    by_image = []
    for image in payload["raw_views"]:
        by_image.append(
            [
                (
                    item["view_id"],
                    Detection(
                        item["class_id"],
                        item["class_name"],
                        item["confidence"],
                        tuple(item["xyxy"]),
                    ),
                )
                for item in image["detections"]
            ]
        )
    targets = [
        Target(item["image_id"], item["class_id"], tuple(item["xyxy"]))
        for item in payload["targets"]
    ]
    return by_image, targets


def selected_summary(tuning: dict) -> dict:
    classes = [item["selected"] | {"class_name": item["class_name"]} for item in tuning["classes"]]
    return {
        "constraints_met": all(item["constraints_met"] for item in tuning["classes"]),
        "minimum_score": min(min(item["precision"], item["recall"]) for item in classes),
        "f1_sum": sum(item["f1"] for item in classes),
        "classes": classes,
    }


def main() -> int:
    args = parse_args()
    if args.output.exists():
        raise SystemExit(f"Output already exists: {args.output}")
    if not args.cache.is_file():
        raise SystemExit(f"Cache not found: {args.cache}")

    by_image, targets = load_cache(args.cache)
    # This deliberately stays coarse: it identifies a promising region before a smaller fine sweep.
    configurations = [
        (min_votes, agreement_iou, high_smoke, high_fire)
        for min_votes in (2, 3, 4)
        for agreement_iou in (0.40, 0.60)
        for high_smoke in (0.55, 0.65)
        for high_fire in (0.45, 0.60, 0.75)
    ]
    rows = []
    for index, (min_votes, agreement_iou, high_smoke, high_fire) in enumerate(configurations, start=1):
        settings = argparse.Namespace(
            min_votes=min_votes,
            agreement_iou=agreement_iou,
            high_conf_smoke=high_smoke,
            high_conf_fire=high_fire,
        )
        predictions: list[Prediction] = []
        for image_id, detections in enumerate(by_image):
            predictions.extend(to_predictions(image_id, consensus(detections, settings)))
        tuning = tune_class_thresholds(predictions, targets, FIRE_SMOKE_NAMES, args)
        summary = selected_summary(tuning)
        row = {
            "consensus": {
                "min_votes": min_votes,
                "agreement_iou": agreement_iou,
                "high_conf_smoke": high_smoke,
                "high_conf_fire": high_fire,
            },
            "selected": summary,
            "threshold_tuning": tuning,
        }
        rows.append(row)
        smoke, fire = summary["classes"]
        print(
            f"[tta-sweep] {index:02d}/{len(configurations)} votes={min_votes} iou={agreement_iou:.2f} "
            f"smoke={smoke['precision']:.4f}/{smoke['recall']:.4f} "
            f"fire={fire['precision']:.4f}/{fire['recall']:.4f} "
            f"constraints={summary['constraints_met']}",
            flush=True,
        )
    best = max(
        rows,
        key=lambda row: (
            row["selected"]["constraints_met"],
            row["selected"]["minimum_score"],
            row["selected"]["f1_sum"],
        ),
    )
    args.output.mkdir(parents=True)
    serializable_settings = {
        key: str(value) if isinstance(value, Path) else value
        for key, value in vars(args).items()
    }
    payload = {
        "cache": str(args.cache),
        "settings": serializable_settings,
        "image_count": len(by_image),
        "candidate_count": len(rows),
        "best": best,
        "candidates": rows,
    }
    (args.output / "tta_consensus_sweep.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    summary = best["selected"]
    smoke, fire = summary["classes"]
    print(
        "[tta-sweep] best "
        f"votes={best['consensus']['min_votes']} iou={best['consensus']['agreement_iou']:.2f} "
        f"high_smoke={best['consensus']['high_conf_smoke']:.2f} "
        f"high_fire={best['consensus']['high_conf_fire']:.2f} "
        f"smoke={smoke['precision']:.4f}/{smoke['recall']:.4f} "
        f"fire={fire['precision']:.4f}/{fire['recall']:.4f} "
        f"constraints={summary['constraints_met']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
