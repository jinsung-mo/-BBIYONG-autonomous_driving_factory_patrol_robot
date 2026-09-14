#!/usr/bin/env python3
"""Compare raw PyTorch and TensorRT outputs for one preprocessed image."""

from __future__ import annotations

import argparse
import json
import sys

import cv2
import numpy as np
import torch

from infer_trt import TrtModel, preprocess  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pt", required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--precision", choices=("fp32", "fp16"), default="fp32")
    parser.add_argument("--json")
    args = parser.parse_args()

    import ultralytics  # noqa: F401

    image = cv2.imread(args.image)
    if image is None:
        raise SystemExit(f"cannot read {args.image}")

    checkpoint = torch.load(args.pt, map_location="cpu", weights_only=False)
    model = (checkpoint.get("ema") or checkpoint["model"]).float().fuse().eval().cuda()
    if args.precision == "fp16":
        model = model.half()
    array, _, _ = preprocess(image, (1, 3, 640, 640))
    tensor = torch.from_numpy(array).cuda()
    if args.precision == "fp16":
        tensor = tensor.half()
    with torch.inference_mode():
        pt_output = model(tensor)
        pt_output = pt_output[0] if isinstance(pt_output, (tuple, list)) else pt_output
    torch.cuda.synchronize()
    pt_compute_dtype = str(pt_output.dtype)
    pt_array = pt_output.float().cpu().numpy()

    trt_model = TrtModel(args.engine)
    try:
        trt_array = trt_model.infer(array).copy()
    finally:
        trt_model.close()

    difference = np.abs(pt_array - trt_array)
    flat_pt = pt_array.reshape(-1).astype(np.float64)
    flat_trt = trt_array.reshape(-1).astype(np.float64)
    cosine = float(np.dot(flat_pt, flat_trt) / (np.linalg.norm(flat_pt) * np.linalg.norm(flat_trt)))
    result = {
        "image": args.image,
        "pytorch_precision": args.precision,
        "pytorch_compute_dtype": pt_compute_dtype,
        "shape": list(pt_array.shape),
        "comparison_dtype": str(pt_array.dtype),
        "tensorrt_io_dtype": str(trt_array.dtype),
        "abs_diff_mean": float(difference.mean()),
        "abs_diff_max": float(difference.max()),
        "cosine_similarity": cosine,
        "class_score_abs_diff_mean": float(difference[:, 4:, :].mean()),
        "class_score_abs_diff_max": float(difference[:, 4:, :].max()),
    }
    print(json.dumps(result, indent=2))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
