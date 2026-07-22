from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from ultralytics import YOLO

from dataset_utils import print_report, validate_dataset
from training_evaluation import attach_before_after_evaluation
from training_progress import attach_progress_callbacks


AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROJECT = AI_ROOT / "artifacts" / "runs"
SUPPORTED_MODELS = ("yolo11n.pt", "yolo11s.pt", "yolo26n.pt")
AUGMENTATION_PRESETS = {
    "fire-smoke": {
        "degrees": 5.0,
        "translate": 0.10,
        "scale": 0.40,
        "fliplr": 0.50,
        "flipud": 0.0,
        "hsv_h": 0.015,
        "hsv_s": 0.50,
        "hsv_v": 0.30,
        "mosaic": 0.50,
        "mixup": 0.05,
    },
    "ultralytics": {
        "degrees": 0.0,
        "translate": 0.10,
        "scale": 0.50,
        "fliplr": 0.50,
        "flipud": 0.0,
        "hsv_h": 0.015,
        "hsv_s": 0.70,
        "hsv_v": 0.40,
        "mosaic": 1.0,
        "mixup": 0.0,
    },
    "none": {
        "degrees": 0.0,
        "translate": 0.0,
        "scale": 0.0,
        "fliplr": 0.0,
        "flipud": 0.0,
        "hsv_h": 0.0,
        "hsv_s": 0.0,
        "hsv_v": 0.0,
        "mosaic": 0.0,
        "mixup": 0.0,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a BBIYONG fire/smoke detector")
    parser.add_argument("--data", default=str(AI_ROOT / "data" / "fire_smoke" / "data.yaml"))
    parser.add_argument("--model", choices=SUPPORTED_MODELS, default="yolo11n.pt")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="auto", help="auto, cpu, or CUDA device such as 0")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--optimizer",
        choices=("auto", "AdamW", "SGD", "MuSGD"),
        default="auto",
        help="Optimizer; auto selects an Ultralytics recipe from the run size",
    )
    parser.add_argument("--lr0", type=float, default=0.01, help="Initial learning rate")
    parser.add_argument("--lrf", type=float, default=0.01, help="Final LR as a fraction of lr0")
    parser.add_argument(
        "--lr-schedule",
        choices=("cosine", "linear"),
        default="cosine",
        help="Learning-rate decay schedule",
    )
    parser.add_argument("--warmup-epochs", type=float, default=3.0)
    parser.add_argument("--patience", type=int, default=30)
    parser.add_argument("--close-mosaic", type=int, default=10)
    parser.add_argument(
        "--eval-before-train",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Evaluate the initialized two-class model before the first optimizer step",
    )
    parser.add_argument(
        "--comparison-split",
        choices=("val", "test"),
        default="test",
        help="Frozen split used for both before- and after-training comparison",
    )
    parser.add_argument(
        "--augment-preset",
        choices=tuple(AUGMENTATION_PRESETS),
        default="fire-smoke",
        help="Frozen augmentation policy for the experiment",
    )
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT)
    parser.add_argument("--name", help="Run name; defaults to the checkpoint stem")
    parser.add_argument("--resume", type=Path, help="Path to last.pt from an interrupted run")
    return parser.parse_args()


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    return "0" if torch.cuda.is_available() else "cpu"


def augmentation_args(preset: str) -> dict[str, float]:
    return dict(AUGMENTATION_PRESETS[preset])


def main() -> int:
    args = parse_args()
    if args.epochs < 1 or args.imgsz < 32 or args.batch == 0:
        raise SystemExit("epochs must be >= 1, imgsz >= 32, and batch must not be 0")
    if args.lr0 <= 0.0 or not 0.0 < args.lrf <= 1.0:
        raise SystemExit("lr0 must be positive and lrf must be in the range (0, 1]")
    if args.warmup_epochs < 0.0 or args.patience < 0 or args.close_mosaic < 0:
        raise SystemExit("warmup epochs, patience, and close-mosaic cannot be negative")

    if args.resume:
        checkpoint = args.resume.resolve()
        if not checkpoint.is_file():
            raise SystemExit(f"Resume checkpoint does not exist: {checkpoint}")
        model = YOLO(str(checkpoint))
        attach_progress_callbacks(model)
        attach_before_after_evaluation(
            model,
            run_baseline=False,
            comparison_split=args.comparison_split,
        )
        model.train(resume=True)
        return 0

    data_path = Path(args.data)
    if not data_path.is_file():
        raise SystemExit(f"Dataset YAML does not exist: {data_path}")
    report = validate_dataset(data_path)
    print_report(report)
    if not report.ok:
        raise SystemExit("Dataset validation failed; training was not started")

    device = resolve_device(args.device)
    if device != "cpu" and not torch.cuda.is_available():
        raise SystemExit("A CUDA device was requested, but CUDA is unavailable")

    model = YOLO(args.model)
    attach_progress_callbacks(model)
    if args.eval_before_train:
        attach_before_after_evaluation(
            model,
            run_baseline=True,
            comparison_split=args.comparison_split,
        )
    training_options = {
        "data": str(data_path.resolve()),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "device": device,
        "workers": args.workers,
        "seed": args.seed,
        "deterministic": True,
        "pretrained": True,
        "optimizer": args.optimizer,
        "lr0": args.lr0,
        "lrf": args.lrf,
        "cos_lr": args.lr_schedule == "cosine",
        "warmup_epochs": args.warmup_epochs,
        "patience": args.patience,
        "close_mosaic": args.close_mosaic,
        "amp": True,
        "plots": True,
        "project": str(args.project.resolve()),
        "name": args.name or Path(args.model).stem,
        "exist_ok": False,
        **augmentation_args(args.augment_preset),
    }
    print(
        "resolved_training_options="
        + json.dumps(
            {
                **training_options,
                "augment_preset": args.augment_preset,
                "eval_before_train": args.eval_before_train,
                "comparison_split": args.comparison_split,
            },
            sort_keys=True,
            ensure_ascii=False,
        ),
        flush=True,
    )
    if args.optimizer == "auto":
        print(
            "NOTE: optimizer=auto lets Ultralytics choose optimizer, lr0, and momentum; "
            "keep batch and epochs identical across comparison runs.",
            flush=True,
        )
    model.train(**training_options)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

