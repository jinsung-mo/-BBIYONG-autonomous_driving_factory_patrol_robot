# Fire/smoke Jetson deployment

The deployed model is the `ai/main` checkpoint:

`AI/artifacts/runs/indoor-from-fasdd-yolo11n-plus10/weights/best.pt`

Class order is fixed as `0: smoke`, `1: fire`. The ONNX graph has static input
shape `1x3x640x640`, output shape `1x6x8400`, and opset 17. The TensorRT engine
must be built on the target Jetson because engine files are tied to its GPU,
TensorRT version, and driver.

Model binaries and generated outputs are intentionally excluded by
`AI/.gitignore`. Fetch the checkpoint through Git LFS from `ai/main`, then
export it in the AI virtual environment:

```bash
python AI/deployment/fire_smoke/export_onnx.py \
  AI/artifacts/runs/indoor-from-fasdd-yolo11n-plus10/weights/best.pt \
  --device 0
```

Copy the resulting ONNX file to the Jetson and build the engine on-device:

```bash
WORKSPACE_MIB=1024 bash build_engine.sh \
  models/fire_smoke_yolo11n.onnx \
  models/fire_smoke_yolo11n_fp16.engine
```

Run TensorRT inference on the default camera:

```bash
bash /home/e101/fire-smoke-deploy/run_tensorrt.sh
```

Pass any options supported by `infer_trt.py`, for example a video source:

```bash
bash /home/e101/fire-smoke-deploy/run_tensorrt.sh --source clip.mp4 --frames 300
```

Benchmark the `.pt` path on the fixed frame set:

```bash
/home/e101/venvs/fire-smoke/bin/python \
  /home/e101/fire-smoke-deploy/benchmark_pt.py \
  --model /home/e101/fire-smoke-deploy/models/fire_smoke_yolo11n.pt \
  --frames /home/e101/bench/frames_clean --repeat 3 --precision fp16
```

Benchmark TensorRT on the same frame set:

```bash
python3 /home/e101/fire-smoke-deploy/benchmark_engine.py \
  --engine /home/e101/fire-smoke-deploy/models/fire_smoke_yolo11n_fp16.engine \
  --frames /home/e101/bench/frames_clean --names fire --repeat 3
```

## Verified Jetson result (2026-08-03)

Target: Jetson Orin, JetPack/L4T R36.4.7, CUDA 12.6, TensorRT 10.3.0,
640x640 static batch 1. PyTorch was measured in both FP32 and FP16 CUDA modes;
TensorRT used FP16 tactics with FP32 input/output bindings. Both full-pipeline
tests used the same 40 JPEGs, confidence 0.40, five repeats (200 timed frames),
and the same letterbox/decode implementation.

| Backend | Core/infer mean | Pipeline mean | Pipeline FPS |
|---|---:|---:|---:|
| PyTorch FP32 `.pt` | 30.165 ms | 35.287 ms | 28.34 |
| PyTorch FP16 `.pt` | 24.744 ms | 29.970 ms | 33.37 |
| TensorRT FP16 engine | 10.510 ms | 14.170 ms | 70.60 |

The precision-matched comparison is PyTorch FP16 versus TensorRT FP16:
TensorRT delivered **2.12x end-to-end throughput**. The FP32 row is retained as
a deployment-default baseline, not as the fair backend comparison.
`trtexec` separately measured
the engine's GPU compute at 4.338 ms mean and 4.069 ms median with CUDA Graphs;
this optimistic kernel-only number is not directly comparable to the Python
pipeline measurement.

FP16 PT/engine parity on the same frame produced cosine similarity 0.99999955.
The maximum absolute difference among class scores was 0.0000486. The 40 clean
frames produced no detections at 0.40 from either backend; they are suitable
for timing and false-positive smoke testing, not for measuring fire/smoke mAP.

Artifact SHA-256:

```text
c25e96f7cc2609663043b7acb80dbcdb3a70dba384fa26d8aaf75d332525c441  fire_smoke_yolo11n.pt
1ec804d51b2f0c5d5631b64dd352f05a49fd635031bd20dddb282fe199e7495e  fire_smoke_yolo11n.onnx
b877f3874f63f673348d08b4b0f3cf35d555e8142a81308ead7d9c1e8aa2e9a0  fire_smoke_yolo11n_fp16.engine
```
