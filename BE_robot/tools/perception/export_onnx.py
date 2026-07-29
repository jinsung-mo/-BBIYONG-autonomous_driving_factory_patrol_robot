"""Export a BBIYONG fire/smoke YOLO checkpoint to ONNX on the development PC.

Runs on the PC only. The Orin has no PyTorch/ultralytics/onnx by design, so the
whole .pt -> .onnx step happens here and only the .onnx is copied to the robot.

Required PC packages (NOT installed yet, see report):
    ultralytics==8.4.102      # pinned by team AI/requirements.txt; needed to
                              #   unpickle checkpoints that carry yolo26-era keys
                              #   (cls_remap, quantize, end2end, distill_model)
    onnx                      # graph writer + checker
    onnxslim                  # ultralytics >=8.3 uses onnxslim for simplify=True
                              #   (it replaced onnx-simplifier)
    onnxruntime               # optional; only used by --verify
torch is already present on this PC (2.11.0+cu128).

A GPU is NOT required. ONNX export is a symbolic trace, not a training step, so
device="cpu" produces a byte-identical graph. We default to CPU to keep the
export deterministic and independent of the local CUDA stack.

Usage
    python export_onnx.py --model <path/to/best.pt> --output <out.onnx>
    python export_onnx.py --model best.pt --output out.onnx --verify
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

# Class contract fixed by the dataset and by AI/scripts/camera_inference.py
# (FIRE_SMOKE_NAMES). Order must never change: label files index into it.
FIRE_SMOKE_NAMES = ["smoke", "fire"]

# ---------------------------------------------------------------------------
# opset choice
# ---------------------------------------------------------------------------
# TensorRT 10.3's ONNX parser accepts ONNX opsets up to 20. YOLO11's detect head
# only needs ops that stabilised long before that (Conv, Sigmoid, Mul, Add,
# Split, Concat, Transpose, Slice, Resize, MaxPool, Softmax for the DFL layer).
#
# We pin opset 17 rather than taking ultralytics' "latest" default because:
#   1. 17 is inside TRT 10.3's supported range with headroom, so a future
#      ultralytics bump cannot silently emit opset 21+ that the parser rejects.
#   2. 17 is the most heavily exercised opset in the TensorRT ONNX parser
#      (it is the level at which LayerNormalization/Attention-era ops landed and
#      it is what NVIDIA's own YOLO samples target).
#   3. Nothing in YOLO11 requires 18/19/20 semantics, so a higher opset buys
#      nothing and only widens the surface for parser edge cases.
# If the parser ever complains, opset 16 and 19 are the sensible fallbacks.
DEFAULT_OPSET = 17

# ---------------------------------------------------------------------------
# NMS: deliberately NOT baked into the ONNX graph  (nms=False)
# ---------------------------------------------------------------------------
# ultralytics can export an end-to-end graph whose tail is the EfficientNMS_TRT
# plugin. We do not do that here. Reasons, in order of weight:
#
#   1. The team pipeline needs RAW candidates. AI/scripts/tune_postprocessing.py
#      runs inference once at candidate_conf=0.001..0.01 and then sweeps a
#      per-class operating threshold offline; AI/scripts/postprocessing.py then
#      applies DIFFERENT thresholds for smoke and fire plus a hysteresis
#      (hold_threshold) that changes at runtime once a class is active.
#      EfficientNMS_TRT takes a single scalar score threshold baked in at build
#      time, so the tuned per-class + hysteresis policy could not be applied.
#
#   2. The n->s cascade (AI/scripts/cascade.py) fuses two models' boxes with a
#      geometric-mean confidence and then runs its own class-aware NMS at
#      final_nms_iou=0.50, while the per-model NMS runs at iou=0.70. Two NMS
#      stages with different IoUs cannot both live inside one plugin.
#
#   3. Cost of doing NMS on the CPU is negligible here: 8400 candidates, and
#      after the candidate-confidence filter typically <50 survive. A numpy
#      greedy NMS on that is well under a millisecond on the Orin's A78AE.
#
#   4. A plain graph keeps the .onnx portable and lets infer_trt.py reproduce
#      ultralytics' exact NMS semantics (multi_label=False, class-offset NMS,
#      IoU > thr suppression) instead of the plugin's slightly different ones.
#
# Consequence for build_engine.sh: no plugin library is needed, plain trtexec
# --onnx is enough.
#
# ---------------------------------------------------------------------------
# Output tensor shape
# ---------------------------------------------------------------------------
#   input   "images"  : float32  (1, 3, 640, 640)   RGB, CHW, values in [0, 1]
#   output  "output0" : float32  (1, 4 + nc, 8400)  ->  (1, 6, 8400) for nc=2
#
# 8400 = 80*80 + 40*40 + 20*20 anchor points for a 640x640 input.
# Row layout along axis 1: [cx, cy, w, h, score_smoke, score_fire].
# Boxes are in PIXELS of the 640x640 letterboxed input (not normalised).
# Scores are already sigmoid-activated; there is no separate objectness term.
# The script prints the real shape after export so this comment can be checked.


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a fire/smoke YOLO .pt checkpoint to ONNX for TensorRT"
    )
    parser.add_argument("--model", required=True, type=Path, help="Path to best.pt")
    parser.add_argument(
        "--output", required=True, type=Path, help="Destination .onnx path"
    )
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--opset", type=int, default=DEFAULT_OPSET)
    parser.add_argument(
        "--device", default="cpu", help="cpu (default) or a CUDA index such as 0"
    )
    parser.add_argument(
        "--allow-any-classes",
        action="store_true",
        help="Skip the 0=smoke / 1=fire contract check (use for official COCO weights)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run one onnxruntime forward pass on zeros to confirm the graph loads",
    )
    return parser.parse_args()


def check_class_contract(model, allow_any: bool) -> None:
    names = model.names
    if isinstance(names, dict):
        ordered = [str(names[i]).strip().lower() for i in range(len(names))]
    else:
        ordered = [str(n).strip().lower() for n in names]
    print("classes={}".format(ordered))
    if ordered == FIRE_SMOKE_NAMES:
        print("fire_smoke_contract=OK (0: smoke, 1: fire)")
        return
    message = "Checkpoint classes {} != required {}".format(ordered, FIRE_SMOKE_NAMES)
    if allow_any:
        print("WARNING: " + message)
        return
    raise SystemExit("ERROR: " + message + "  (pass --allow-any-classes to override)")


def main() -> int:
    args = parse_args()
    if not args.model.is_file():
        raise SystemExit("ERROR: model not found: {}".format(args.model))
    if args.imgsz % 32 != 0:
        raise SystemExit("ERROR: --imgsz must be a multiple of 32")

    from ultralytics import YOLO  # imported late so --help works without it

    model = YOLO(str(args.model))
    check_class_contract(model, args.allow_any_classes)

    exported = model.export(
        format="onnx",
        imgsz=args.imgsz,
        opset=args.opset,
        # batch 1, static shapes. The robot processes one camera frame at a
        # time, so a dynamic batch axis would only cost TensorRT the chance to
        # specialise kernels for N=1.
        dynamic=False,
        batch=1,
        simplify=True,
        # FP32 graph. FP16 is applied later by trtexec --fp16, which lets
        # TensorRT keep numerically sensitive layers in higher precision. An
        # FP16 ONNX would force the loss before the builder can decide.
        half=False,
        # See the long comment above: raw candidates, no EfficientNMS plugin.
        nms=False,
        device=args.device,
    )

    exported_path = Path(exported)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if exported_path.resolve() != args.output.resolve():
        shutil.move(str(exported_path), str(args.output))
    size_mb = args.output.stat().st_size / (1024 * 1024)
    print("onnx={}  ({:.1f} MiB)".format(args.output, size_mb))

    import onnx

    graph = onnx.load(str(args.output))
    onnx.checker.check_model(graph)
    for tensor in list(graph.graph.input) + list(graph.graph.output):
        dims = [
            d.dim_value if d.HasField("dim_value") else (d.dim_param or "?")
            for d in tensor.type.tensor_type.shape.dim
        ]
        kind = "input " if tensor in list(graph.graph.input) else "output"
        print("{}  {:<10} shape={}".format(kind, tensor.name, dims))
    print("ir_version={} opset={}".format(graph.ir_version, graph.opset_import[0].version))

    if args.verify:
        import numpy as np
        import onnxruntime as ort

        session = ort.InferenceSession(
            str(args.output), providers=["CPUExecutionProvider"]
        )
        input_name = session.get_inputs()[0].name
        dummy = np.zeros((1, 3, args.imgsz, args.imgsz), dtype=np.float32)
        outputs = session.run(None, {input_name: dummy})
        for name, value in zip([o.name for o in session.get_outputs()], outputs):
            print("verify: {} -> {} {}".format(name, value.shape, value.dtype))

    print(
        "\nNext: copy to the Orin, then build there.\n"
        "  scp {} orin:~/trt/\n"
        "  ssh orin 'bash ~/trt/build_engine.sh ~/trt/{}'".format(
            args.output, args.output.name
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
