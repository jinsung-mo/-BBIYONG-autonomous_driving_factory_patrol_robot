#!/usr/bin/env python3
"""Benchmark a YOLO .pt checkpoint on the Jetson with a fixed image set."""

from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import sys
import time

import cv2
import numpy as np
import torch

from infer_trt import decode, preprocess  # noqa: E402


def stats(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    return {
        "mean": round(statistics.fmean(values), 3),
        "median": round(statistics.median(values), 3),
        "p95": round(ordered[int(0.95 * (len(ordered) - 1))], 3),
        "min": round(ordered[0], 3),
        "max": round(ordered[-1], 3),
        "n": len(values),
    }


def load_model(path: str, precision: str) -> torch.nn.Module:
    # Importing Ultralytics registers the model classes stored in the checkpoint.
    import ultralytics  # noqa: F401

    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    model = checkpoint.get("ema") or checkpoint["model"]
    model = model.float().fuse().eval().cuda()
    if precision == "fp16":
        model = model.half()
    return model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--frames", required=True)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--warmup", type=int, default=30)
    parser.add_argument("--conf", type=float, default=0.40)
    parser.add_argument("--precision", choices=("fp32", "fp16"), default="fp32")
    parser.add_argument("--json")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable; refusing to report a CPU benchmark")

    files = sorted(glob.glob(os.path.join(args.frames, "*.jpg")))
    images = [(path, cv2.imread(path)) for path in files]
    images = [(path, image) for path, image in images if image is not None]
    if not images:
        raise SystemExit(f"no readable JPG frames in {args.frames}")

    model = load_model(args.model, args.precision)
    input_shape = (1, 3, 640, 640)
    warm_array, _, _ = preprocess(images[0][1], input_shape)

    with torch.inference_mode():
        warm = torch.from_numpy(warm_array).cuda()
        if args.precision == "fp16":
            warm = warm.half()
        for _ in range(args.warmup):
            model(warm)
        torch.cuda.synchronize()

        core_ms: list[float] = []
        pipeline_ms: list[float] = []
        detections = 0
        for _ in range(args.repeat):
            for _, image in images:
                start_total = time.perf_counter()
                array, ratio, pad = preprocess(image, input_shape)
                tensor = torch.from_numpy(array).cuda()
                if args.precision == "fp16":
                    tensor = tensor.half()
                torch.cuda.synchronize()
                start_core = time.perf_counter()
                output = model(tensor)
                output = output[0] if isinstance(output, (tuple, list)) else output
                torch.cuda.synchronize()
                end_core = time.perf_counter()
                raw = output.float().cpu().numpy()
                decoded = decode(
                    raw,
                    ratio,
                    pad,
                    image.shape,
                    candidate_conf=args.conf,
                    nms_iou=0.45,
                    max_det=30,
                )
                end_total = time.perf_counter()
                core_ms.append((end_core - start_core) * 1000.0)
                pipeline_ms.append((end_total - start_total) * 1000.0)
                detections += len(decoded)

    result = {
        "backend": f"pytorch-{args.precision}-cuda",
        "model": args.model,
        "model_mb": round(os.path.getsize(args.model) / 1048576, 3),
        "device": torch.cuda.get_device_name(0),
        "torch": torch.__version__,
        "frames": len(images),
        "repeat": args.repeat,
        "core_ms": stats(core_ms),
        "pipeline_ms": stats(pipeline_ms),
        "core_fps": round(1000.0 / statistics.fmean(core_ms), 2),
        "pipeline_fps": round(1000.0 / statistics.fmean(pipeline_ms), 2),
        "detections_across_repeats": detections,
    }
    print(json.dumps(result, indent=2))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
