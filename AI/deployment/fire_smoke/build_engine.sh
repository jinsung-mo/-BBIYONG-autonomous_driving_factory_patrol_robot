#!/usr/bin/env bash
set -euo pipefail

TRTEXEC="${TRTEXEC:-/usr/src/tensorrt/bin/trtexec}"
ONNX="${1:?usage: build_engine.sh MODEL.onnx [MODEL.engine]}"
ENGINE="${2:-${ONNX%.onnx}.fp16.engine}"
WORKSPACE_MIB="${WORKSPACE_MIB:-1024}"

"$TRTEXEC" \
  --onnx="$ONNX" \
  --saveEngine="$ENGINE" \
  --fp16 \
  --memPoolSize="workspace:${WORKSPACE_MIB}" \
  --useCudaGraph \
  --iterations=200 \
  --avgRuns=100 \
  --warmUp=1000 \
  --verbose=false

sha256sum "$ENGINE"
ls -lh "$ONNX" "$ENGINE"
