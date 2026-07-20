from __future__ import annotations

import argparse
from pathlib import Path

import torch
from ultralytics import YOLO

from dataset_utils import print_report, validate_dataset


AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROJECT = AI_ROOT / "artifacts" / "runs"
SUPPORTED_MODELS = ("yolo11n.pt", "yolo11s.pt", "yolo26n.pt")


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
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT)
    parser.add_argument("--name", help="Run name; defaults to the checkpoint stem")
    parser.add_argument("--resume", type=Path, help="Path to last.pt from an interrupted run")
    return parser.parse_args()


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    return "0" if torch.cuda.is_available() else "cpu"


def main() -> int:
    args = parse_args()
    if args.epochs < 1 or args.imgsz < 32 or args.batch == 0:
        raise SystemExit("epochs must be >= 1, imgsz >= 32, and batch must not be 0")

    if args.resume:
        checkpoint = args.resume.resolve()
        if not checkpoint.is_file():
            raise SystemExit(f"Resume checkpoint does not exist: {checkpoint}")
        YOLO(str(checkpoint)).train(resume=True)
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
    model.train(
        data=str(data_path.resolve()),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        workers=args.workers,
        seed=args.seed,
        deterministic=True,
        pretrained=True,
        patience=30,
        close_mosaic=10,
        cos_lr=True,
        amp=True,
        plots=True,
        project=str(args.project.resolve()),
        name=args.name or Path(args.model).stem,
        exist_ok=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

