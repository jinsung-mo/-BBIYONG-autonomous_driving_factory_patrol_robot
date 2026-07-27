from __future__ import annotations

import argparse
import csv
import hashlib
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import torch
from ultralytics import YOLO

from dataset_utils import print_report, validate_dataset


AI_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_CLASSES = {0: "smoke", 1: "fire"}
MODEL_NAMES = ("yolo11n", "yolo11s", "yolo26n")
METRIC_NAMES = ("precision", "recall", "map50", "map50_95")


def parse_model_specs(values: Iterable[str]) -> dict[str, Path]:
    """Parse exactly one NAME=CHECKPOINT entry for each project candidate."""
    models: dict[str, Path] = {}
    for value in values:
        name, separator, raw_path = value.partition("=")
        name = name.strip().lower()
        if not separator or not name or not raw_path.strip():
            raise ValueError(f"Invalid model specification {value!r}; expected NAME=PATH")
        if name not in MODEL_NAMES:
            raise ValueError(f"Unknown model {name!r}; expected one of {', '.join(MODEL_NAMES)}")
        if name in models:
            raise ValueError(f"Model {name!r} was supplied more than once")
        models[name] = Path(raw_path.strip()).expanduser().resolve()

    missing = [name for name in MODEL_NAMES if name not in models]
    if missing:
        raise ValueError(f"Missing model specification(s): {', '.join(missing)}")
    return {name: models[name] for name in MODEL_NAMES}


def normalize_names(names: Any) -> dict[int, str]:
    if isinstance(names, dict):
        return {int(index): str(name) for index, name in names.items()}
    return {index: str(name) for index, name in enumerate(names)}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def scalar(value: Any) -> float:
    if hasattr(value, "item"):
        value = value.item()
    return float(value)


def extract_metrics(results: Any, class_names: dict[int, str]) -> tuple[dict[str, float], list[dict[str, Any]]]:
    precision, recall, map50, map5095 = results.box.mean_results()
    aggregate = {
        "precision": scalar(precision),
        "recall": scalar(recall),
        "map50": scalar(map50),
        "map50_95": scalar(map5095),
    }
    per_class = []
    for class_id, class_name in sorted(class_names.items()):
        precision, recall, map50, map5095 = results.box.class_result(class_id)
        per_class.append(
            {
                "class_id": class_id,
                "class_name": class_name,
                "precision": scalar(precision),
                "recall": scalar(recall),
                "map50": scalar(map50),
                "map50_95": scalar(map5095),
            }
        )
    return aggregate, per_class


def parameter_count(model: YOLO) -> int:
    return sum(parameter.numel() for parameter in model.model.parameters())


def summarize_values(values: Iterable[float]) -> tuple[float, float]:
    """Return the arithmetic mean and population standard deviation."""
    samples = [scalar(value) for value in values]
    if not samples:
        raise ValueError("Cannot summarize an empty sequence")
    return statistics.fmean(samples), statistics.pstdev(samples)


def summarize_repeats(repeats: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate repeated evaluations while retaining each raw result."""
    if not repeats:
        raise ValueError("At least one evaluation repeat is required")

    aggregate: dict[str, float] = {}
    aggregate_std: dict[str, float] = {}
    for metric in METRIC_NAMES:
        aggregate[metric], aggregate_std[metric] = summarize_values(
            repeat["aggregate"][metric] for repeat in repeats
        )

    class_ids = [item["class_id"] for item in repeats[0]["per_class"]]
    per_class = []
    per_class_std = []
    for class_id in class_ids:
        first = next(item for item in repeats[0]["per_class"] if item["class_id"] == class_id)
        mean_item = {"class_id": class_id, "class_name": first["class_name"]}
        std_item = {"class_id": class_id, "class_name": first["class_name"]}
        for metric in METRIC_NAMES:
            values = (
                next(item for item in repeat["per_class"] if item["class_id"] == class_id)[metric]
                for repeat in repeats
            )
            mean_item[metric], std_item[metric] = summarize_values(values)
        per_class.append(mean_item)
        per_class_std.append(std_item)

    speed_keys = sorted({key for repeat in repeats for key in repeat["speed_ms"]})
    speed_ms: dict[str, float] = {}
    speed_ms_std: dict[str, float] = {}
    for key in speed_keys:
        speed_ms[key], speed_ms_std[key] = summarize_values(
            repeat["speed_ms"][key] for repeat in repeats if key in repeat["speed_ms"]
        )

    return {
        "repeat_count": len(repeats),
        "aggregate": aggregate,
        "aggregate_std": aggregate_std,
        "per_class": per_class,
        "per_class_std": per_class_std,
        "speed_ms": speed_ms,
        "speed_ms_std": speed_ms_std,
        "repeats": repeats,
    }


def configure_inference_determinism(enabled: bool) -> None:
    """Toggle deterministic algorithms without autotuning variable validation shapes."""
    torch.use_deterministic_algorithms(enabled, warn_only=True)
    if torch.backends.cudnn.is_available():
        torch.backends.cudnn.deterministic = enabled
        # Validation uses aspect-ratio-dependent batch shapes. Enabling the cuDNN
        # benchmark makes it autotune kernels repeatedly and is much slower here.
        torch.backends.cudnn.benchmark = False


def metrics_match(repeats: list[dict[str, Any]], tolerance: float = 1e-12) -> bool:
    """Check aggregate and per-class accuracy metrics against the first pass."""
    if not repeats:
        return False
    expected = repeats[0]
    for current in repeats[1:]:
        for metric in METRIC_NAMES:
            if abs(current["aggregate"][metric] - expected["aggregate"][metric]) > tolerance:
                return False
        for expected_class, current_class in zip(
            expected["per_class"], current["per_class"], strict=True
        ):
            if current_class["class_id"] != expected_class["class_id"]:
                return False
            for metric in METRIC_NAMES:
                if abs(current_class[metric] - expected_class[metric]) > tolerance:
                    return False
    return True


def write_csv(records: list[dict[str, Any]], path: Path) -> None:
    fields = (
        "model",
        "scope",
        "class_id",
        "class_name",
        "precision",
        "precision_std",
        "recall",
        "recall_std",
        "map50",
        "map50_std",
        "map50_95",
        "map50_95_std",
        "repeats",
        "parameters",
        "checkpoint_mb",
        "preprocess_ms",
        "preprocess_ms_std",
        "inference_ms",
        "inference_ms_std",
        "postprocess_ms",
        "postprocess_ms_std",
    )
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for record in records:
            common = {
                "model": record["model"],
                "parameters": record["parameters"],
                "checkpoint_mb": record["checkpoint_mb"],
                "repeats": record.get("repeat_count", 1),
                "preprocess_ms": record["speed_ms"].get("preprocess"),
                "preprocess_ms_std": record.get("speed_ms_std", {}).get("preprocess", 0.0),
                "inference_ms": record["speed_ms"].get("inference"),
                "inference_ms_std": record.get("speed_ms_std", {}).get("inference", 0.0),
                "postprocess_ms": record["speed_ms"].get("postprocess"),
                "postprocess_ms_std": record.get("speed_ms_std", {}).get("postprocess", 0.0),
            }
            aggregate_std = record.get("aggregate_std", {})
            writer.writerow(
                {
                    **common,
                    "scope": "all",
                    "class_id": "",
                    "class_name": "all",
                    **record["aggregate"],
                    **{f"{metric}_std": aggregate_std.get(metric, 0.0) for metric in METRIC_NAMES},
                }
            )
            class_std = {item["class_id"]: item for item in record.get("per_class_std", [])}
            for class_metrics in record["per_class"]:
                std = class_std.get(class_metrics["class_id"], {})
                writer.writerow(
                    {
                        **common,
                        "scope": "class",
                        **class_metrics,
                        **{f"{metric}_std": std.get(metric, 0.0) for metric in METRIC_NAMES},
                    }
                )


def write_chart(records: list[dict[str, Any]], path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = [record["model"] for record in records]
    map_values = [record["aggregate"]["map50_95"] for record in records]
    map_errors = [record.get("aggregate_std", {}).get("map50_95", 0.0) for record in records]
    smoke_recall = [record["per_class"][0]["recall"] for record in records]
    fire_recall = [record["per_class"][1]["recall"] for record in records]
    positions = list(range(len(labels)))
    width = 0.25

    figure, axis = plt.subplots(figsize=(9, 5))
    axis.bar(
        [x - width for x in positions],
        map_values,
        width,
        yerr=map_errors,
        capsize=3,
        label="mAP50-95",
    )
    axis.bar(positions, smoke_recall, width, label="Smoke recall")
    axis.bar([x + width for x in positions], fire_recall, width, label="Fire recall")
    axis.set_title("Fine-tuned model evaluation")
    axis.set_ylabel("Score")
    axis.set_ylim(0.0, 1.0)
    axis.set_xticks(positions, labels)
    axis.grid(axis="y", alpha=0.25)
    axis.legend()
    figure.tight_layout()
    figure.savefig(path, dpi=160)
    plt.close(figure)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate and compare the three fine-tuned BBIYONG detectors"
    )
    parser.add_argument(
        "--models",
        nargs="+",
        required=True,
        metavar="NAME=BEST_PT",
        help="Supply yolo11n, yolo11s, and yolo26n checkpoints",
    )
    parser.add_argument("--data", type=Path, default=AI_ROOT / "data" / "fire_smoke" / "data.yaml")
    parser.add_argument("--split", choices=("val", "test"), default="test")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="auto", help="auto, cpu, or a CUDA device such as 0")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--conf", type=float, default=0.001)
    parser.add_argument("--iou", type=float, default=0.7)
    parser.add_argument("--max-det", type=int, default=300)
    parser.add_argument(
        "--repeats",
        type=int,
        default=5,
        help="Number of non-deterministic evaluation passes averaged per model (default: 5)",
    )
    parser.add_argument(
        "--deterministic-checks",
        type=int,
        default=3,
        help="Deterministic reproducibility passes run before averaging (default: 3)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=AI_ROOT / "artifacts" / "evaluations" / "three-model-comparison",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        checkpoints = parse_model_specs(args.models)
    except ValueError as error:
        raise SystemExit(str(error)) from error

    missing = [f"{name}: {path}" for name, path in checkpoints.items() if not path.is_file()]
    if missing:
        raise SystemExit("Missing fine-tuned checkpoint(s):\n  " + "\n  ".join(missing))
    data_path = args.data.expanduser().resolve()
    if not data_path.is_file():
        raise SystemExit(f"Dataset YAML does not exist: {data_path}")
    if (
        args.imgsz < 32
        or args.batch == 0
        or args.workers < 0
        or args.max_det < 1
        or args.repeats < 1
        or args.deterministic_checks < 1
    ):
        raise SystemExit(
            "imgsz must be >= 32, batch non-zero, workers >= 0, max-det >= 1, "
            "repeats >= 1, and deterministic-checks >= 1"
        )
    if not 0.0 <= args.conf <= 1.0 or not 0.0 < args.iou <= 1.0:
        raise SystemExit("conf must be in [0, 1] and iou must be in (0, 1]")

    report = validate_dataset(data_path)
    print_report(report)
    if not report.ok:
        raise SystemExit("Dataset validation failed; evaluation was not started")

    output = args.output.expanduser().resolve()
    if output.exists():
        raise SystemExit(f"Output already exists; choose a new --output directory: {output}")
    output.mkdir(parents=True)

    device = ("0" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    if device != "cpu" and not torch.cuda.is_available():
        raise SystemExit("A CUDA device was requested, but CUDA is unavailable")

    records = []
    for name, checkpoint in checkpoints.items():
        print(f"[evaluation] model={name} checkpoint={checkpoint}", flush=True)
        model = YOLO(str(checkpoint))
        class_names = normalize_names(model.names)
        if class_names != EXPECTED_CLASSES:
            raise SystemExit(
                f"Checkpoint {checkpoint} has classes {class_names}; expected {EXPECTED_CLASSES}"
            )
        deterministic_results = []
        configure_inference_determinism(True)
        for repeat_index in range(1, args.deterministic_checks + 1):
            print(
                f"[evaluation] model={name} deterministic-check="
                f"{repeat_index}/{args.deterministic_checks}",
                flush=True,
            )
            results = model.val(
                data=str(data_path),
                split=args.split,
                imgsz=args.imgsz,
                batch=args.batch,
                device=device,
                workers=args.workers,
                conf=args.conf,
                iou=args.iou,
                max_det=args.max_det,
                deterministic=True,
                plots=False,
                project=str(output / name),
                name=f"deterministic-check-{repeat_index:02d}",
                exist_ok=False,
            )
            aggregate, per_class = extract_metrics(results, class_names)
            deterministic_results.append(
                {
                    "repeat": repeat_index,
                    "aggregate": aggregate,
                    "per_class": per_class,
                    "speed_ms": {key: scalar(value) for key, value in results.speed.items()},
                    "plots_directory": str(Path(results.save_dir).resolve()),
                }
            )
        deterministic_check = summarize_repeats(deterministic_results)
        deterministic_check["metrics_match"] = metrics_match(deterministic_results)
        print(
            f"[evaluation] model={name} deterministic-metrics-match="
            f"{deterministic_check['metrics_match']}",
            flush=True,
        )

        repeat_results = []
        configure_inference_determinism(False)
        for repeat_index in range(1, args.repeats + 1):
            print(
                f"[evaluation] model={name} averaged-pass={repeat_index}/{args.repeats} "
                "deterministic=False",
                flush=True,
            )
            results = model.val(
                data=str(data_path),
                split=args.split,
                imgsz=args.imgsz,
                batch=args.batch,
                device=device,
                workers=args.workers,
                conf=args.conf,
                iou=args.iou,
                max_det=args.max_det,
                deterministic=False,
                plots=repeat_index == 1,
                project=str(output / name),
                name=f"average-pass-{repeat_index:02d}",
                exist_ok=False,
            )
            aggregate, per_class = extract_metrics(results, class_names)
            repeat_results.append(
                {
                    "repeat": repeat_index,
                    "aggregate": aggregate,
                    "per_class": per_class,
                    "speed_ms": {key: scalar(value) for key, value in results.speed.items()},
                    "plots_directory": str(Path(results.save_dir).resolve()),
                }
            )
        repeated_summary = summarize_repeats(repeat_results)
        records.append(
            {
                "model": name,
                "checkpoint": str(checkpoint),
                "checkpoint_sha256": sha256(checkpoint),
                "checkpoint_mb": round(checkpoint.stat().st_size / (1024 * 1024), 3),
                "parameters": parameter_count(model),
                "deterministic_check": deterministic_check,
                **repeated_summary,
            }
        )

    ranking = sorted(records, key=lambda record: record["aggregate"]["map50_95"], reverse=True)
    summary = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": str(data_path),
        "dataset_yaml_sha256": sha256(data_path),
        "split": args.split,
        "settings": {
            "imgsz": args.imgsz,
            "batch": args.batch,
            "device": device,
            "workers": args.workers,
            "conf": args.conf,
            "iou": args.iou,
            "max_det": args.max_det,
            "repeats": args.repeats,
            "deterministic_checks": args.deterministic_checks,
            "ranking_phase": "non_deterministic_average",
        },
        "selection_metric": "aggregate.map50_95",
        "ranking": [record["model"] for record in ranking],
        "models": records,
    }
    (output / "comparison.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    write_csv(records, output / "comparison.csv")
    write_chart(records, output / "comparison.png")

    print("\nMean values across repeated evaluation passes:", flush=True)
    print("model       smoke_R   fire_R  mAP50-95       inference_ms", flush=True)
    for record in ranking:
        print(
            f"{record['model']:<11} {record['per_class'][0]['recall']:>7.4f} "
            f"{record['per_class'][1]['recall']:>8.4f} "
            f"{record['aggregate']['map50_95']:>6.4f}"
            f"+/-{record['aggregate_std']['map50_95']:<6.4f} "
            f"{record['speed_ms'].get('inference', float('nan')):>8.3f}"
            f"+/-{record['speed_ms_std'].get('inference', float('nan')):<7.3f}",
            flush=True,
        )
    print(f"[evaluation] comparison={output / 'comparison.json'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
