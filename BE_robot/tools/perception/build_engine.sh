#!/usr/bin/env bash
# Build a TensorRT engine from a BBIYONG fire/smoke ONNX file. RUN ON THE ORIN.
#
#   bash build_engine.sh ~/trt/yolo11n_firesmoke.onnx [output.engine]
#
# Verified facts about this Orin (read-only survey, 2026-07-25):
#   TensorRT 10.3.0.30, CUDA 12.6.68, L4T R36.4.7, aarch64
#   trtexec is NOT on PATH -> it lives at /usr/src/tensorrt/bin/trtexec
#   RAM 7.4 GiB total (unified with the GPU), ~5 GiB available
#   Swap is 6 x 635 MiB zram (compressed RAM, ~3.7 GiB) -- there is NO disk swap,
#     so an OOM during the build cannot be absorbed by a page file.
#   Power mode: 25W (nvpmodel mode 1), not MAXN SUPER.
#
set -euo pipefail

TRTEXEC="${TRTEXEC:-/usr/src/tensorrt/bin/trtexec}"
ONNX="${1:?usage: build_engine.sh <model.onnx> [model.engine]}"
ENGINE="${2:-${ONNX%.onnx}.fp16.engine}"

# --- workspace pool -------------------------------------------------------
# TensorRT 10 replaced --workspace with --memPoolSize=workspace:<MiB>.
# On Jetson the workspace comes out of the SAME 7.4 GiB the OS and the camera
# pipeline use; it is not separate VRAM. The builder allocates the pool for
# tactic timing, so an over-large value can push the box into zram thrash or
# the OOM killer mid-build, and there is no disk swap to save it.
# 1024 MiB is comfortably more than yolo11n/yolo11s at 640x640 need and leaves
# ~4 GiB for everything else. Raise to 2048 only if the log reports a tactic
# being skipped for insufficient workspace.
WORKSPACE_MIB="${WORKSPACE_MIB:-1024}"

# --- precision ------------------------------------------------------------
# FP16 only. The Orin Nano's tensor cores run FP16 at roughly 2x FP32 with no
# calibration data and no accuracy work, which is the whole reason we are not
# stopping at FP32. TensorRT still keeps layers in FP32 where FP16 would
# overflow, so this is not a blanket cast.
#
# INT8 is deliberately NOT enabled -- see the commented block at the bottom.

echo "trtexec : ${TRTEXEC}"
echo "onnx    : ${ONNX}"
echo "engine  : ${ENGINE}"
echo "workspace: ${WORKSPACE_MIB} MiB"
echo

# Optional but recommended before building AND before benchmarking, otherwise
# the DVFS governor ramps clocks up and down and the measured latency drifts:
#   sudo nvpmodel -m 2      # MAXN SUPER (this box is currently mode 1 = 25W)
#   sudo jetson_clocks
# Leave the clocks pinned for the trtexec run so its numbers match infer_trt.py.

# EXPECT THIS TO BE SLOW. The builder times every candidate kernel for every
# layer on the actual device. On an Orin Nano at 25W, a 640x640 YOLO11n takes
# roughly 3-8 minutes and YOLO11s roughly 6-15 minutes. It is not hung; watch
# the [MemUsageChange] / tactic lines. Run it under tmux/nohup if the SSH link
# is flaky, because losing the shell kills the build.
#   --builderOptimizationLevel=2 cuts build time noticeably at a small runtime
#   cost; the default is 3. Uncomment if iteration speed matters more than fps.

"${TRTEXEC}" \
  --onnx="${ONNX}" \
  --saveEngine="${ENGINE}" \
  --fp16 \
  --memPoolSize=workspace:"${WORKSPACE_MIB}" \
  --useCudaGraph \
  --iterations=100 \
  --avgRuns=100 \
  --warmUp=1000 \
  --verbose=false
  # --builderOptimizationLevel=2 \

# trtexec runs the engine after building it, so the "GPU Compute Time" block at
# the end of the log is the pure engine latency with no Python, no camera and no
# letterbox. Record median and mean -- infer_trt.py should land close to the
# median plus a few ms of capture/preprocess/NMS overhead.
#
# --useCudaGraph removes per-launch CPU overhead in the benchmark. infer_trt.py
# does NOT use CUDA graphs (the TensorRT Python API path is enqueue-based), so
# treat the trtexec number as a slightly optimistic floor.

echo
echo "built: ${ENGINE}"
ls -lh "${ENGINE}"

# An engine is tied to the exact TensorRT version, GPU architecture and, for
# some tactics, the driver. It is NOT portable: never copy an engine built on
# the PC to the Orin, and rebuild after any JetPack upgrade.

# ---------------------------------------------------------------------------
# INT8 -- follow-up task, NOT enabled now
# ---------------------------------------------------------------------------
# INT8 would give roughly another 1.5-2x over FP16 on Orin, but it needs a
# calibration cache built from a few hundred representative images, and trtexec
# cannot produce that cache from a raw image folder -- it only consumes an
# existing one via --calib=<file>. Producing it requires either a custom
# IInt8EntropyCalibrator2 (C++/Python) or polygraphy, and neither is installed.
#
# Before enabling it we also have to re-measure mAP: smoke is a low-contrast,
# large-area class and is the most likely to lose recall under INT8.
#
# Sketch once a calibration cache exists (use D-Fire val images, NOT test):
#
#   "${TRTEXEC}" \
#     --onnx="${ONNX}" \
#     --saveEngine="${ENGINE%.fp16.engine}.int8.engine" \
#     --int8 --fp16 \
#     --calib=/path/to/calibration.cache \
#     --memPoolSize=workspace:"${WORKSPACE_MIB}"
#
# --int8 --fp16 together lets the builder fall back to FP16 for layers where
# INT8 is slower or unrepresentable, rather than to FP32.
