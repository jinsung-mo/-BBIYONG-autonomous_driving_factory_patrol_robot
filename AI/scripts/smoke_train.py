from __future__ import annotations

from pathlib import Path

import torch
from ultralytics import YOLO


AI_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    device = 0 if torch.cuda.is_available() else "cpu"
    model = YOLO("yolo11n.pt")
    model.train(
        data="coco8.yaml",
        epochs=1,
        imgsz=320,
        batch=2,
        device=device,
        workers=2,
        seed=42,
        deterministic=True,
        project=str((AI_ROOT / "artifacts" / "smoke").resolve()),
        name="coco8-yolo11n",
        exist_ok=True,
        plots=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

