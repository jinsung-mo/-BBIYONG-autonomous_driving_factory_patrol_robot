#!/usr/bin/env python3
"""Export the two-class BBIYONG YOLO checkpoint to static ONNX."""

from __future__ import annotations

import argparse
from pathlib import Path

import onnx
from ultralytics import YOLO


EXPECTED_NAMES = {0: "smoke", 1: "fire"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    model = YOLO(str(args.checkpoint))
    if model.names != EXPECTED_NAMES:
        raise SystemExit(
            f"unexpected class mapping {model.names}; expected {EXPECTED_NAMES}"
        )

    exported = Path(
        model.export(
            format="onnx",
            imgsz=args.imgsz,
            batch=1,
            dynamic=False,
            simplify=False,
            opset=args.opset,
            device=args.device,
        )
    )
    graph = onnx.load(str(exported))
    onnx.checker.check_model(graph)
    print(exported.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
