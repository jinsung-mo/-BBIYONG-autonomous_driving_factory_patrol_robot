#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${ENGINE:-$DEPLOY_DIR/models/fire_smoke_yolo11n_fp16.engine}"
exec python3 "$DEPLOY_DIR/infer_trt.py" \
  --engine "$ENGINE" "$@"
