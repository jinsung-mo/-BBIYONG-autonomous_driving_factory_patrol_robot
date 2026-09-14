"""Headless TensorRT fire/smoke inference on the Orin. No PyTorch, no ultralytics.

Dependencies, all already present on the Orin:
    tensorrt 10.3.0   (python3-libnvinfer, system dist-packages)
    numpy    1.21.5   (apt)
    cv2      4.5.4    (apt python3-opencv)
    ctypes / stdlib   (used to reach libcudart.so.12 -- see below)

    python3 infer_trt.py --engine yolo11n_firesmoke.fp16.engine
    python3 infer_trt.py --engine model.engine --source clip.mp4 --frames 300

WHY ctypes INSTEAD OF pycuda
    Neither pycuda nor cuda-python is installed on the Orin, and the decision was
    to install nothing. The TensorRT Python API can bind and enqueue an engine
    but it cannot allocate device memory or copy to it -- that is the CUDA
    runtime's job. So this file drives libcudart.so.12 directly through ctypes:
    cudaMalloc / cudaMemcpyAsync / cudaStreamCreate / cudaStreamSynchronize.
    That is ~40 lines and adds zero packages. If pycuda is ever installed, the
    CudaBuffer class is the only thing that would change.

HEADLESS
    No cv2.imshow anywhere. Detections and FPS go to stdout only.

=============================================================================
MATCHING THE TEAM AI PIPELINE  (S15P11E101, branch ai/dev)
=============================================================================
Read from AI/scripts/{camera_inference,evaluate_cascade,tune_postprocessing,
postprocessing,cascade}.py at commit on origin/ai/dev.

  PREPROCESS -- reproduced exactly
    ultralytics LetterBox: scale by min(640/h, 640/w), scaleup=True, pad with
    (114,114,114) split evenly on both sides, top/left = round(pad-0.1),
    bottom/right = round(pad+0.1). Then BGR->RGB, HWC->CHW, float32, /255.
    No mean/std normalisation -- ultralytics does not use any.

    ONE DELIBERATE DIFFERENCE, and it is the safe direction:
    when ultralytics runs a *.pt* model on a single frame it sets LetterBox
    auto=True, which pads only to the next multiple of 32. A 640x480 Brio frame
    therefore runs at 640x480 on the PC, not 640x640. A TensorRT engine has a
    fixed 640x640 input, so we use auto=False (square pad). This is exactly what
    ultralytics itself does for any non-.pt backend (onnx/engine), so the engine
    sees the input it was exported for. Expect small numeric differences versus
    the PC .pt preview; the PC .onnx/.engine path would match this file.

  DECODE
    Raw output (1, 4+nc, 8400). Row layout [cx, cy, w, h, smoke, fire], boxes in
    640-space pixels, scores already sigmoid'd, no objectness channel.

  NMS -- reproduced from ultralytics ops.non_max_suppression as called by
  DetectionPredictor.postprocess:
    * multi_label is NOT passed by the predictor, so it is False: one best class
      per candidate (argmax), not one row per class over threshold.
    * candidate filter is strictly greater-than (> conf, not >=).
    * class-aware: ultralytics offsets boxes by class_id * 7680 before a single
      torchvision.ops.nms. Per-class greedy NMS is equivalent; we then re-sort
      globally by score so the max_det truncation matches.
    * torchvision suppresses when IoU > threshold (strict), so we use > here.
    * max_nms=30000 pre-sort cap, then max_det cap.

  THRESHOLDS -- team defaults, all overridable
    candidate_conf 0.01   PostprocessConfig.candidate_confidence (live default;
                          the offline evaluators use 0.001/0.25)
    nms_iou        0.70   PostprocessConfig.nms_iou, and args.yaml iou: 0.7
    max_det        300    PostprocessConfig.max_det
    per-class      0.25   camera_inference --conf / CascadeConfig.primary_conf

  NOT IMPLEMENTED HERE, and why
    1. Per-class tuned thresholds. AI/scripts/tune_postprocessing.py writes
       artifacts/postprocessing/.../postprocess_config.json with a separate
       threshold + hold_threshold for smoke and fire. THAT FILE IS NOT COMMITTED
       to ai/dev, so the real tuned numbers are unknown. --conf-smoke/--conf-fire
       exist so they can be filled in once the JSON is obtained.
    2. Temporal M-of-N alarm policy (window 5, min_hits 3, clear_after 3,
       hysteresis via hold_threshold) -- AI/scripts/postprocessing.py.
    3. yolo11n -> yolo11s cascade (verify_low 0.15, verify_high 0.60,
       primary_conf 0.25, agreement_iou 0.50, verifier_only_conf 0.75,
       final_nms_iou 0.50, verifier_interval 5) -- AI/scripts/cascade.py.
    (2) and (3) are pure-stdlib modules whose only torch dependency is the
    detections_from_result() helper. They can be copied to the Orin verbatim and
    fed the Detection tuples this file already produces -- that is the intended
    next step, kept out of this file to keep one script to one job.
=============================================================================
"""

from __future__ import annotations

import argparse
import ctypes
import time

import cv2
import numpy as np
import tensorrt as trt

CLASS_NAMES = ["smoke", "fire"]  # 0=smoke, 1=fire -- contract, do not reorder

# ultralytics ops.non_max_suppression constants
MAX_NMS = 30000
CLASS_OFFSET = 7680.0  # max_wh; only relevant to the offset trick we replace


# ---------------------------------------------------------------------------
# CUDA runtime through ctypes (no pycuda / cuda-python on this device)
# ---------------------------------------------------------------------------
_MEMCPY_HOST_TO_DEVICE = 1
_MEMCPY_DEVICE_TO_HOST = 2


def _load_cudart():
    for name in ("libcudart.so.12", "libcudart.so"):
        try:
            lib = ctypes.CDLL(name)
            break
        except OSError:
            lib = None
    if lib is None:
        raise RuntimeError(
            "libcudart.so.12 not found. It is at /usr/local/cuda/lib64; add that "
            "to LD_LIBRARY_PATH or run ldconfig."
        )
    # argtypes are mandatory on aarch64: without them ctypes passes pointers as
    # 32-bit ints and cudaMalloc silently corrupts the address.
    lib.cudaMalloc.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t]
    lib.cudaMalloc.restype = ctypes.c_int
    lib.cudaFree.argtypes = [ctypes.c_void_p]
    lib.cudaFree.restype = ctypes.c_int
    lib.cudaMemcpyAsync.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_int,
        ctypes.c_void_p,
    ]
    lib.cudaMemcpyAsync.restype = ctypes.c_int
    lib.cudaStreamCreate.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    lib.cudaStreamCreate.restype = ctypes.c_int
    lib.cudaStreamSynchronize.argtypes = [ctypes.c_void_p]
    lib.cudaStreamSynchronize.restype = ctypes.c_int
    lib.cudaStreamDestroy.argtypes = [ctypes.c_void_p]
    lib.cudaStreamDestroy.restype = ctypes.c_int
    lib.cudaGetErrorString.argtypes = [ctypes.c_int]
    lib.cudaGetErrorString.restype = ctypes.c_char_p
    return lib


_CUDART = None


def _cuda(status: int, what: str) -> None:
    if status != 0:
        message = _CUDART.cudaGetErrorString(status)
        raise RuntimeError(
            "{} failed: {} ({})".format(
                what, message.decode() if message else "?", status
            )
        )


class TrtModel:
    """One engine, one execution context, static batch-1 shapes."""

    def __init__(self, engine_path: str):
        global _CUDART
        _CUDART = _load_cudart()

        self.logger = trt.Logger(trt.Logger.WARNING)
        # Harmless for a plain graph; required if an EfficientNMS engine is ever
        # built instead.
        trt.init_libnvinfer_plugins(self.logger, "")
        with open(engine_path, "rb") as handle:
            blob = handle.read()
        runtime = trt.Runtime(self.logger)
        self.engine = runtime.deserialize_cuda_engine(blob)
        if self.engine is None:
            raise RuntimeError(
                "Failed to deserialize {}. An engine is tied to the exact "
                "TensorRT version and GPU it was built on -- rebuild it here "
                "with build_engine.sh.".format(engine_path)
            )
        self.context = self.engine.create_execution_context()

        stream = ctypes.c_void_p()
        _cuda(_CUDART.cudaStreamCreate(ctypes.byref(stream)), "cudaStreamCreate")
        self.stream = stream

        self.inputs = []
        self.outputs = []
        self.device_ptrs = []
        for index in range(self.engine.num_io_tensors):
            name = self.engine.get_tensor_name(index)
            shape = tuple(self.engine.get_tensor_shape(name))
            if any(dim < 0 for dim in shape):
                raise RuntimeError(
                    "Engine tensor {} has a dynamic dim {}. export_onnx.py builds "
                    "static batch-1 graphs; rebuild without dynamic axes.".format(
                        name, shape
                    )
                )
            dtype = trt.nptype(self.engine.get_tensor_dtype(name))
            host = np.zeros(shape, dtype=dtype)
            device = ctypes.c_void_p()
            _cuda(
                _CUDART.cudaMalloc(ctypes.byref(device), host.nbytes), "cudaMalloc"
            )
            self.device_ptrs.append(device)
            self.context.set_tensor_address(name, device.value)
            entry = {"name": name, "shape": shape, "host": host, "device": device}
            if self.engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
                self.inputs.append(entry)
            else:
                self.outputs.append(entry)

        if len(self.inputs) != 1:
            raise RuntimeError(
                "Expected exactly 1 input, got {}".format(len(self.inputs))
            )
        self.input_shape = self.inputs[0]["shape"]  # (1, 3, H, W)

    def infer(self, chw: np.ndarray) -> np.ndarray:
        """chw: float32 (1, 3, H, W). Returns the first output as a numpy copy."""
        source = self.inputs[0]
        np.copyto(source["host"], chw)
        _cuda(
            _CUDART.cudaMemcpyAsync(
                source["device"],
                ctypes.c_void_p(source["host"].ctypes.data),
                source["host"].nbytes,
                _MEMCPY_HOST_TO_DEVICE,
                self.stream,
            ),
            "cudaMemcpyAsync H2D",
        )
        if not self.context.execute_async_v3(self.stream.value):
            raise RuntimeError("execute_async_v3 returned False")
        for sink in self.outputs:
            _cuda(
                _CUDART.cudaMemcpyAsync(
                    ctypes.c_void_p(sink["host"].ctypes.data),
                    sink["device"],
                    sink["host"].nbytes,
                    _MEMCPY_DEVICE_TO_HOST,
                    self.stream,
                ),
                "cudaMemcpyAsync D2H",
            )
        _cuda(_CUDART.cudaStreamSynchronize(self.stream), "cudaStreamSynchronize")
        return self.outputs[0]["host"]

    def close(self) -> None:
        for device in self.device_ptrs:
            _CUDART.cudaFree(device)
        self.device_ptrs = []
        if self.stream is not None:
            _CUDART.cudaStreamDestroy(self.stream)
            self.stream = None


# ---------------------------------------------------------------------------
# Preprocess -- ultralytics LetterBox(auto=False, scaleup=True, center=True)
# ---------------------------------------------------------------------------
def letterbox(image, new_shape, color=(114, 114, 114)):
    height, width = image.shape[:2]
    ratio = min(float(new_shape[0]) / height, float(new_shape[1]) / width)
    # scaleup=True: ultralytics predict() does upscale small frames.
    unpad_w = int(round(width * ratio))
    unpad_h = int(round(height * ratio))
    pad_w = (new_shape[1] - unpad_w) / 2.0
    pad_h = (new_shape[0] - unpad_h) / 2.0
    if (width, height) != (unpad_w, unpad_h):
        image = cv2.resize(image, (unpad_w, unpad_h), interpolation=cv2.INTER_LINEAR)
    top = int(round(pad_h - 0.1))
    bottom = int(round(pad_h + 0.1))
    left = int(round(pad_w - 0.1))
    right = int(round(pad_w + 0.1))
    image = cv2.copyMakeBorder(
        image, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color
    )
    return image, ratio, (pad_w, pad_h)


def preprocess(frame, input_shape):
    padded, ratio, pad = letterbox(frame, (input_shape[2], input_shape[3]))
    rgb = padded[:, :, ::-1]                       # BGR -> RGB
    chw = rgb.transpose(2, 0, 1)                   # HWC -> CHW
    tensor = np.ascontiguousarray(chw, dtype=np.float32) / 255.0
    return tensor[np.newaxis, ...], ratio, pad


# ---------------------------------------------------------------------------
# Postprocess
# ---------------------------------------------------------------------------
def nms_numpy(boxes, scores, iou_threshold):
    """Greedy NMS matching torchvision.ops.nms: suppress when IoU > threshold."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        current = order[0]
        keep.append(current)
        if order.size == 1:
            break
        rest = order[1:]
        inter_w = np.maximum(
            0.0, np.minimum(x2[current], x2[rest]) - np.maximum(x1[current], x1[rest])
        )
        inter_h = np.maximum(
            0.0, np.minimum(y2[current], y2[rest]) - np.maximum(y1[current], y1[rest])
        )
        intersection = inter_w * inter_h
        union = areas[current] + areas[rest] - intersection
        iou = np.where(union > 0.0, intersection / np.maximum(union, 1e-12), 0.0)
        order = rest[iou <= iou_threshold]
    return np.array(keep, dtype=np.int64)


def decode(output, ratio, pad, original_shape, candidate_conf, nms_iou, max_det):
    """output: (1, 4+nc, 8400) -> list of (class_id, score, box) where
    box is a length-4 array [x1, y1, x2, y2].

    NOTE: an earlier version of this docstring claimed a flat 6-tuple.
    It does not — the box stays packed. A caller that unpacked six
    values crashed the camera node on the first detection.
    """
    predictions = output[0].T                      # (8400, 4+nc)
    boxes_cxcywh = predictions[:, :4]
    class_scores = predictions[:, 4:]

    class_ids = class_scores.argmax(axis=1)
    scores = class_scores[np.arange(class_scores.shape[0]), class_ids]

    # ultralytics: strictly greater-than, not >=
    selected = scores > candidate_conf
    if not selected.any():
        return []
    boxes_cxcywh = boxes_cxcywh[selected]
    scores = scores[selected]
    class_ids = class_ids[selected]

    if scores.shape[0] > MAX_NMS:
        top = scores.argsort()[::-1][:MAX_NMS]
        boxes_cxcywh, scores, class_ids = (
            boxes_cxcywh[top],
            scores[top],
            class_ids[top],
        )

    half_w = boxes_cxcywh[:, 2] / 2.0
    half_h = boxes_cxcywh[:, 3] / 2.0
    boxes = np.stack(
        [
            boxes_cxcywh[:, 0] - half_w,
            boxes_cxcywh[:, 1] - half_h,
            boxes_cxcywh[:, 0] + half_w,
            boxes_cxcywh[:, 1] + half_h,
        ],
        axis=1,
    )

    # Class-aware NMS. Equivalent to ultralytics' class-offset trick; classes
    # never suppress each other, which matters because smoke boxes routinely
    # enclose the fire box inside them.
    kept = []
    for class_id in np.unique(class_ids):
        mask = np.nonzero(class_ids == class_id)[0]
        local = nms_numpy(boxes[mask], scores[mask], nms_iou)
        kept.extend(mask[local].tolist())
    if not kept:
        return []
    kept = np.array(kept, dtype=np.int64)
    kept = kept[scores[kept].argsort()[::-1]][:max_det]

    # Undo the letterbox: remove padding, divide by the scale, clip to frame.
    pad_w, pad_h = pad
    final = boxes[kept].copy()
    final[:, [0, 2]] -= pad_w
    final[:, [1, 3]] -= pad_h
    final /= ratio
    final[:, [0, 2]] = final[:, [0, 2]].clip(0, original_shape[1])
    final[:, [1, 3]] = final[:, [1, 3]].clip(0, original_shape[0])

    return [
        (int(class_ids[index]), float(scores[index]), final[row])
        for row, index in enumerate(kept)
    ]


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------
def open_source(source, width, height, fps):
    if source.isdigit():
        capture = cv2.VideoCapture(int(source), cv2.CAP_V4L2)
        # Brio 100 confirmed format: YUYV 640x480 @30. MJPG is not requested
        # because the confirmed-working mode is YUYV; forcing MJPG on a device
        # that does not advertise it makes VideoCapture fall back silently.
        capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc("Y", "U", "Y", "V"))
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        capture.set(cv2.CAP_PROP_FPS, fps)
        # Keep the V4L2 queue at one frame so a slow model yields the newest
        # frame rather than a growing backlog.
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    else:
        capture = cv2.VideoCapture(source)
    return capture


def parse_args():
    parser = argparse.ArgumentParser(
        description="TensorRT fire/smoke inference on the Orin (headless)"
    )
    parser.add_argument("--engine", required=True)
    parser.add_argument(
        "--source", default="0", help="camera index (default 0 = /dev/video0) or a file"
    )
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument(
        "--candidate-conf",
        type=float,
        default=0.01,
        help="pre-NMS threshold; PostprocessConfig.candidate_confidence default",
    )
    parser.add_argument(
        "--nms-iou", type=float, default=0.70, help="PostprocessConfig.nms_iou default"
    )
    parser.add_argument(
        "--max-det", type=int, default=300, help="PostprocessConfig.max_det default"
    )
    parser.add_argument(
        "--conf-smoke",
        type=float,
        default=0.25,
        help="operating threshold for class 0; replace with the tuned value from "
        "postprocess_config.json once that file exists",
    )
    parser.add_argument("--conf-fire", type=float, default=0.25, help="class 1")
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument(
        "--frames", type=int, default=0, help="stop after N frames; 0 = until Ctrl-C"
    )
    parser.add_argument(
        "--report-every", type=int, default=30, help="FPS line interval, in frames"
    )
    return parser.parse_args()


def main():
    args = parse_args()
    for name, value in (
        ("--candidate-conf", args.candidate_conf),
        ("--nms-iou", args.nms_iou),
        ("--conf-smoke", args.conf_smoke),
        ("--conf-fire", args.conf_fire),
    ):
        if not 0.0 <= value <= 1.0:
            raise SystemExit("ERROR: {} must be in [0, 1]".format(name))
    if args.max_det < 1 or args.warmup < 0 or args.report_every < 1:
        raise SystemExit("ERROR: --max-det/--report-every positive, --warmup >= 0")

    model = TrtModel(args.engine)
    _, channels, net_h, net_w = model.input_shape
    print("engine={}".format(args.engine))
    print("input={} {}".format(model.inputs[0]["name"], model.input_shape))
    for sink in model.outputs:
        print("output={} {}".format(sink["name"], sink["shape"]))
    num_classes = model.outputs[0]["shape"][1] - 4
    if num_classes != len(CLASS_NAMES):
        raise SystemExit(
            "ERROR: engine has {} classes, expected {} ({})".format(
                num_classes, len(CLASS_NAMES), CLASS_NAMES
            )
        )
    print("classes={}".format(CLASS_NAMES))
    class_conf = {0: args.conf_smoke, 1: args.conf_fire}

    dummy = np.zeros((1, channels, net_h, net_w), dtype=np.float32)
    for _ in range(args.warmup):
        model.infer(dummy)
    if args.warmup:
        started = time.perf_counter()
        for _ in range(args.warmup):
            model.infer(dummy)
        engine_ms = (time.perf_counter() - started) * 1000.0 / args.warmup
        print("engine_only_latency_ms={:.2f}".format(engine_ms))

    capture = open_source(args.source, args.width, args.height, args.fps)
    if not capture.isOpened():
        model.close()
        raise SystemExit("ERROR: could not open source {}".format(args.source))
    print(
        "capture={}x{} @ {:.0f}".format(
            int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            capture.get(cv2.CAP_PROP_FPS),
        )
    )
    print("running; Ctrl-C to stop")

    frame_index = 0
    failed_reads = 0
    window_started = time.perf_counter()
    window_infer_ms = 0.0
    window_total_ms = 0.0
    try:
        while True:
            loop_started = time.perf_counter()
            ok, frame = capture.read()
            if not ok:
                failed_reads += 1
                if failed_reads >= 30:
                    print("ERROR: 30 consecutive failed reads")
                    return 4
                continue
            failed_reads = 0
            frame_index += 1

            tensor, ratio, pad = preprocess(frame, model.input_shape)
            infer_started = time.perf_counter()
            output = model.infer(tensor)
            window_infer_ms += (time.perf_counter() - infer_started) * 1000.0

            detections = decode(
                output,
                ratio,
                pad,
                frame.shape[:2],
                args.candidate_conf,
                args.nms_iou,
                args.max_det,
            )
            detections = [
                item for item in detections if item[1] >= class_conf[item[0]]
            ]
            window_total_ms += (time.perf_counter() - loop_started) * 1000.0

            if detections:
                parts = [
                    "{} {:.2f} [{:.0f},{:.0f},{:.0f},{:.0f}]".format(
                        CLASS_NAMES[class_id], score, box[0], box[1], box[2], box[3]
                    )
                    for class_id, score, box in detections
                ]
                print("frame {:>6}  {}".format(frame_index, " | ".join(parts)))

            if frame_index % args.report_every == 0:
                elapsed = max(time.perf_counter() - window_started, 1e-9)
                print(
                    "frame {:>6}  fps={:.1f}  infer={:.1f}ms  pipeline={:.1f}ms".format(
                        frame_index,
                        args.report_every / elapsed,
                        window_infer_ms / args.report_every,
                        window_total_ms / args.report_every,
                    )
                )
                window_started = time.perf_counter()
                window_infer_ms = 0.0
                window_total_ms = 0.0

            if args.frames and frame_index >= args.frames:
                break
    except KeyboardInterrupt:
        print("interrupted")
    finally:
        capture.release()
        model.close()
    print("frames={}".format(frame_index))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
