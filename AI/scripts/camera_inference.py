from __future__ import annotations

import argparse
import os
import time
from datetime import datetime
from pathlib import Path

import cv2
import torch
from ultralytics import YOLO


AI_ROOT = Path(__file__).resolve().parents[1]
OFFICIAL_CANDIDATES = {"yolo11n.pt", "yolo11s.pt", "yolo26n.pt"}
FIRE_SMOKE_NAMES = ["smoke", "fire"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run an Ultralytics YOLO detection model on a laptop camera"
    )
    parser.add_argument(
        "--model",
        default="yolo11n.pt",
        help="Official model name or path to a fine-tuned .pt/.onnx/.engine model",
    )
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index")
    parser.add_argument("--device", default="auto", help="auto, cpu, or CUDA device such as 0")
    parser.add_argument("--imgsz", type=int, default=640, help="Inference image size")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU threshold")
    parser.add_argument("--max-det", type=int, default=100, help="Maximum detections per frame")
    parser.add_argument("--width", type=int, default=0, help="Requested camera width; 0 keeps default")
    parser.add_argument("--height", type=int, default=0, help="Requested camera height; 0 keeps default")
    parser.add_argument(
        "--backend",
        choices=("auto", "dshow", "msmf"),
        default="auto",
        help="Camera backend; dshow/msmf are Windows-specific",
    )
    parser.add_argument("--half", action="store_true", help="Use FP16 inference on CUDA")
    parser.add_argument("--no-mirror", action="store_true", help="Do not mirror the preview")
    return parser.parse_args()


def resolve_model(value: str) -> str:
    requested = Path(value).expanduser()
    candidates = [requested]
    if not requested.is_absolute():
        candidates.extend((Path.cwd() / requested, AI_ROOT / requested))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    if value in OFFICIAL_CANDIDATES:
        # Ultralytics downloads an official checkpoint if it is not available locally.
        return value
    raise FileNotFoundError(f"Model does not exist: {value}")


def resolve_device(value: str) -> str:
    if value != "auto":
        return value
    return "0" if torch.cuda.is_available() else "cpu"


def open_camera(index: int, backend: str) -> cv2.VideoCapture:
    backend_ids = {
        "dshow": cv2.CAP_DSHOW,
        "msmf": cv2.CAP_MSMF,
    }
    if backend == "auto":
        return cv2.VideoCapture(index)
    if os.name != "nt":
        raise ValueError(f"Camera backend '{backend}' is only supported on Windows")
    return cv2.VideoCapture(index, backend_ids[backend])


def normalized_names(model: YOLO) -> list[str]:
    names = model.names
    if isinstance(names, dict):
        return [str(names[index]).strip().lower() for index in range(len(names))]
    return [str(name).strip().lower() for name in names]


def print_model_contract(model: YOLO, model_path: str, device: str) -> None:
    names = normalized_names(model)
    print(f"model={model_path}")
    print(f"device={device}")
    print(f"classes={names}")
    if names == FIRE_SMOKE_NAMES:
        print("fire_smoke_contract=OK (0: smoke, 1: fire)")
    else:
        print(
            "WARNING: This checkpoint is not a two-class BBIYONG fire/smoke model. "
            "Use it only to test the camera/inference path, or pass a fine-tuned best.pt."
        )


def draw_status(frame, fps: float, inference_ms: float, device: str) -> None:
    text = f"FPS {fps:.1f} | inference {inference_ms:.1f} ms | {device} | Q/Esc quit | S save"
    cv2.putText(frame, text, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(frame, text, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 1, cv2.LINE_AA)


def main() -> int:
    args = parse_args()
    if args.imgsz < 32:
        raise SystemExit("--imgsz must be at least 32")
    if not 0.0 <= args.conf <= 1.0 or not 0.0 <= args.iou <= 1.0:
        raise SystemExit("--conf and --iou must be between 0 and 1")
    if args.max_det < 1 or args.width < 0 or args.height < 0:
        raise SystemExit("--max-det must be positive; width and height cannot be negative")

    try:
        model_path = resolve_model(args.model)
        device = resolve_device(args.device)
        if args.half and device == "cpu":
            raise ValueError("--half requires a CUDA device")
        model = YOLO(model_path)
        print_model_contract(model, model_path, device)
        camera = open_camera(args.camera, args.backend)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}")
        return 2

    if args.width:
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    if args.height:
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not camera.isOpened():
        camera.release()
        print(
            f"ERROR: Could not open camera {args.camera}. Try another --camera index "
            "or --backend dshow/msmf on Windows."
        )
        return 3

    screenshots = AI_ROOT / "artifacts" / "camera"
    window_name = f"BBIYONG camera test - {Path(args.model).name}"
    fps_ema = 0.0
    failed_reads = 0
    printed_resolution = False

    print("controls: q/Esc=quit, s=save screenshot")
    try:
        while True:
            loop_started = time.perf_counter()
            ok, frame = camera.read()
            if not ok:
                failed_reads += 1
                if failed_reads >= 30:
                    print("ERROR: Camera failed to return 30 consecutive frames")
                    return 4
                continue
            failed_reads = 0

            if not printed_resolution:
                print(f"camera_resolution={frame.shape[1]}x{frame.shape[0]}")
                printed_resolution = True
            if not args.no_mirror:
                frame = cv2.flip(frame, 1)

            precision_args = {"quantize": 16} if args.half else {}
            results = model.predict(
                source=frame,
                imgsz=args.imgsz,
                conf=args.conf,
                iou=args.iou,
                max_det=args.max_det,
                device=device,
                verbose=False,
                **precision_args,
            )
            result = results[0]
            annotated = result.plot()
            elapsed = max(time.perf_counter() - loop_started, 1e-9)
            instantaneous_fps = 1.0 / elapsed
            fps_ema = instantaneous_fps if fps_ema == 0.0 else 0.9 * fps_ema + 0.1 * instantaneous_fps
            inference_ms = float(result.speed.get("inference", 0.0))
            draw_status(annotated, fps_ema, inference_ms, device)
            cv2.imshow(window_name, annotated)

            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q"), ord("Q")):
                break
            if key in (ord("s"), ord("S")):
                screenshots.mkdir(parents=True, exist_ok=True)
                output = screenshots / f"{Path(args.model).stem}-{datetime.now():%Y%m%d-%H%M%S}.jpg"
                if cv2.imwrite(str(output), annotated):
                    print(f"screenshot={output}")
                else:
                    print(f"WARNING: Could not save screenshot: {output}")
    except KeyboardInterrupt:
        print("Interrupted")
    finally:
        camera.release()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
