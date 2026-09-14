from __future__ import annotations

import argparse
import json
import textwrap
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from camera_inference import (
    FIRE_SMOKE_NAMES,
    draw_postprocessed,
    normalized_names,
    print_model_contract,
    resolve_device,
    resolve_model,
)
from cascade import CascadeConfig, fuse_cascade, should_run_verifier
from postprocessing import (
    ClassPolicy,
    FireSmokePostprocessor,
    PostprocessConfig,
    TemporalPolicy,
    detections_from_result,
)


AI_ROOT = Path(__file__).resolve().parents[1]
TRACKBAR_NAME = "Position"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Play a video with live YOLO11n-to-YOLO11s cascade detection"
    )
    parser.add_argument("--source", type=Path, required=True, help="Input video path")
    parser.add_argument("--model", required=True, help="Primary smoke/fire model checkpoint")
    parser.add_argument(
        "--verifier-model", required=True, help="Verifier smoke/fire model checkpoint"
    )
    parser.add_argument(
        "--postprocess-config",
        type=Path,
        help="Optional validation-tuned post-processing JSON; runtime defaults are used otherwise",
    )
    parser.add_argument("--device", default="auto", help="auto, cpu, or CUDA device such as 0")
    parser.add_argument("--imgsz", type=int, default=640, help="Inference image size")
    parser.add_argument("--conf", type=float, default=0.25, help="Detection display threshold")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU threshold")
    parser.add_argument("--max-det", type=int, default=100, help="Maximum detections per frame")
    parser.add_argument("--half", action="store_true", help="Use FP16 inference on CUDA")
    parser.add_argument("--verify-low", type=float, default=0.15)
    parser.add_argument("--verify-high", type=float, default=0.60)
    parser.add_argument("--primary-conf", type=float, default=0.25)
    parser.add_argument("--agreement-iou", type=float, default=0.50)
    parser.add_argument("--verifier-only-conf", type=float, default=0.75)
    parser.add_argument("--final-nms-iou", type=float, default=0.50)
    parser.add_argument("--verifier-interval", type=int, default=5)
    parser.add_argument("--display-width", type=int, default=960)
    parser.add_argument("--display-height", type=int, default=720)
    parser.add_argument("--log-width", type=int, default=480)
    parser.add_argument("--skip-seconds", type=float, default=5.0)
    parser.add_argument("--large-skip-seconds", type=float, default=30.0)
    return parser.parse_args()


def format_time(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def fit_frame(frame: np.ndarray, max_width: int, max_height: int) -> np.ndarray:
    height, width = frame.shape[:2]
    scale = min(max_width / width, max_height / height, 1.0)
    if scale == 1.0:
        return frame
    return cv2.resize(
        frame,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def default_postprocess_config(args: argparse.Namespace) -> PostprocessConfig:
    candidate_confidence = min(args.conf, args.verify_low, args.verifier_only_conf)
    config = PostprocessConfig(
        classes={
            0: ClassPolicy(threshold=args.conf, hold_threshold=args.conf),
            1: ClassPolicy(threshold=args.conf, hold_threshold=args.conf),
        },
        temporal=TemporalPolicy(),
        candidate_confidence=candidate_confidence,
        nms_iou=args.iou,
        max_det=args.max_det,
        metadata={"source": "video_inference runtime defaults"},
    )
    config.validate()
    return config


def put_line(
    image: np.ndarray,
    text: str,
    y: int,
    *,
    color: tuple[int, int, int] = (220, 225, 230),
    scale: float = 0.48,
    thickness: int = 1,
) -> int:
    cv2.putText(
        image,
        text,
        (16, y),
        cv2.FONT_HERSHEY_SIMPLEX,
        scale,
        color,
        thickness,
        cv2.LINE_AA,
    )
    return y + 21


def compose_player(
    annotated: np.ndarray,
    logs: deque[str],
    *,
    max_video_width: int,
    max_video_height: int,
    panel_width: int,
    paused: bool,
    position_seconds: float,
    duration_seconds: float,
    frame_number: int,
    total_frames: int,
    fps: float,
    inference_ms: float,
    verifier_status: str,
    alarm: str,
    detections: str,
) -> np.ndarray:
    video = fit_frame(annotated, max_video_width, max_video_height)
    video_height, video_width = video.shape[:2]
    canvas_height = max(video_height, 620)
    canvas = np.full((canvas_height, video_width + panel_width, 3), (20, 23, 28), np.uint8)
    top = (canvas_height - video_height) // 2
    canvas[top : top + video_height, :video_width] = video

    panel = canvas[:, video_width:]
    panel[:] = (28, 32, 38)
    cv2.line(panel, (0, 0), (0, canvas_height), (80, 88, 98), 2)
    y = 30
    y = put_line(panel, "BBIYONG CASCADE VIDEO", y, color=(80, 210, 255), scale=0.62, thickness=2)
    y += 5
    state = "PAUSED" if paused else "PLAYING"
    state_color = (80, 190, 255) if paused else (100, 230, 130)
    y = put_line(panel, f"State: {state}", y, color=state_color, scale=0.56, thickness=2)
    y = put_line(
        panel,
        f"Time: {format_time(position_seconds)} / {format_time(duration_seconds)}",
        y,
    )
    y = put_line(panel, f"Frame: {frame_number:,} / {total_frames:,}   Source FPS: {fps:.2f}", y)
    y = put_line(panel, f"Inference: {inference_ms:.1f} ms   Verifier: {verifier_status}", y)
    alarm_text = alarm or "none"
    y = put_line(
        panel,
        f"Alarm: {alarm_text}",
        y,
        color=(80, 80, 255) if alarm else (170, 180, 190),
        thickness=2 if alarm else 1,
    )
    y = put_line(panel, f"Detections: {detections or 'none'}", y)

    y += 12
    y = put_line(panel, "CONTROLS", y, color=(80, 210, 255), scale=0.53, thickness=2)
    for control in (
        "Space/P   pause or resume",
        "A / D     skip -/+ 5 seconds",
        "J / L     skip -/+ 30 seconds",
        ", / .     previous/next frame",
        "R         restart video",
        "S         save annotated view",
        "Q/Esc     quit",
        "Drag the Position bar to seek",
    ):
        y = put_line(panel, control, y, color=(190, 200, 210), scale=0.44)

    y += 10
    y = put_line(panel, "RECENT FRAME LOGS", y, color=(80, 210, 255), scale=0.53, thickness=2)
    available_lines = max(1, (canvas_height - y - 10) // 18)
    wrapped: list[str] = []
    for entry in reversed(logs):
        lines = textwrap.wrap(entry, width=max(30, panel_width // 9)) or [""]
        wrapped[0:0] = lines
        if len(wrapped) >= available_lines:
            wrapped = wrapped[-available_lines:]
            break
    for line in wrapped:
        y = put_line(panel, line, y, color=(155, 165, 175), scale=0.39)
    return canvas


def validate_args(args: argparse.Namespace) -> None:
    if args.imgsz < 32:
        raise ValueError("--imgsz must be at least 32")
    if not 0.0 <= args.conf <= 1.0 or not 0.0 < args.iou <= 1.0:
        raise ValueError("--conf must be in [0, 1] and --iou in (0, 1]")
    if args.max_det < 1:
        raise ValueError("--max-det must be positive")
    if min(args.display_width, args.display_height, args.log_width) < 100:
        raise ValueError("display and log dimensions must be at least 100 pixels")
    if args.skip_seconds <= 0 or args.large_skip_seconds <= 0:
        raise ValueError("skip intervals must be positive")


def main() -> int:
    args = parse_args()
    try:
        validate_args(args)
        source = args.source.expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(f"Video does not exist: {source}")
        model_path = resolve_model(args.model)
        verifier_path = resolve_model(args.verifier_model)
        device = resolve_device(args.device)
        if args.half and device == "cpu":
            raise ValueError("--half requires a CUDA device")

        model = YOLO(model_path)
        verifier_model = YOLO(verifier_path)
        print_model_contract(model, model_path, device)
        names = normalized_names(model)
        verifier_names = normalized_names(verifier_model)
        if names != FIRE_SMOKE_NAMES or verifier_names != FIRE_SMOKE_NAMES:
            raise ValueError("Both checkpoints must use classes 0: smoke, 1: fire")

        if args.postprocess_config:
            config_path = args.postprocess_config.expanduser().resolve()
            postprocess_config = PostprocessConfig.load(config_path)
            print(f"postprocess_config={config_path}")
        else:
            postprocess_config = default_postprocess_config(args)
            print("postprocess_config=runtime defaults")
        postprocessor = FireSmokePostprocessor(postprocess_config)

        cascade_config = CascadeConfig(
            verify_low=args.verify_low,
            verify_high=args.verify_high,
            primary_confidence=args.primary_conf,
            agreement_iou=args.agreement_iou,
            verifier_only_confidence=args.verifier_only_conf,
            final_nms_iou=args.final_nms_iou,
            verifier_interval=args.verifier_interval,
        )
        cascade_config.validate()
        capture = cv2.VideoCapture(str(source))
        if not capture.isOpened():
            raise RuntimeError(f"Could not open video: {source}")
    except (FileNotFoundError, KeyError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 2

    source_fps = float(capture.get(cv2.CAP_PROP_FPS))
    if source_fps <= 0:
        source_fps = 30.0
    total_frames = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    duration_seconds = total_frames / source_fps
    frame_period = 1.0 / source_fps
    window_name = f"BBIYONG cascade - {source.name}"
    screenshots = AI_ROOT / "artifacts" / "video"
    precision_args = {"half": True} if args.half else {}

    player = {"paused": False, "seek": None, "updating": False, "force_read": False}
    logs: deque[str] = deque(maxlen=80)
    annotated: np.ndarray | None = None
    position_seconds = 0.0
    frame_number = 0
    inference_ms = 0.0
    verifier_runs = 0
    processed_frames = 0
    verifier_status = "skip (0%)"
    alarm = ""
    detection_summary = ""
    last_composite: np.ndarray | None = None

    def trackbar_changed(value: int) -> None:
        if not player["updating"]:
            player["seek"] = value
            player["force_read"] = True

    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    cv2.createTrackbar(TRACKBAR_NAME, window_name, 0, total_frames - 1, trackbar_changed)
    print(f"source={source}")
    print(f"video={total_frames} frames, {source_fps:.3f} FPS, {format_time(duration_seconds)}")
    print("controls: Space/P pause, A/D +/-5s, J/L +/-30s, ,/. frame, R restart, S save, Q quit")

    try:
        while True:
            loop_started = time.perf_counter()
            if player["seek"] is not None:
                target = max(0, min(total_frames - 1, int(player["seek"])))
                capture.set(cv2.CAP_PROP_POS_FRAMES, target)
                postprocessor.reset()
                frame_number = target
                player["seek"] = None
                logs.append(f"SEEK -> {format_time(target / source_fps)} (frame {target:,})")

            should_read = not player["paused"] or bool(player["force_read"])
            if should_read:
                player["force_read"] = False
                ok, frame = capture.read()
                if not ok:
                    player["paused"] = True
                    logs.append("END OF VIDEO - press R or seek to continue")
                else:
                    processed_frames += 1
                    frame_number = max(0, int(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1)
                    position_seconds = frame_number / source_fps
                    results = model.predict(
                        source=frame,
                        imgsz=args.imgsz,
                        conf=postprocess_config.candidate_confidence,
                        iou=postprocess_config.nms_iou,
                        max_det=postprocess_config.max_det,
                        device=device,
                        verbose=False,
                        **precision_args,
                    )
                    primary_result = results[0]
                    primary = detections_from_result(primary_result, names)
                    run_verifier = should_run_verifier(primary, frame_number + 1, cascade_config)
                    verifier = None
                    verifier_ms = 0.0
                    if run_verifier:
                        verifier_runs += 1
                        verifier_result = verifier_model.predict(
                            source=frame,
                            imgsz=args.imgsz,
                            conf=min(
                                cascade_config.verify_low,
                                cascade_config.verifier_only_confidence,
                            ),
                            iou=postprocess_config.nms_iou,
                            max_det=postprocess_config.max_det,
                            device=device,
                            verbose=False,
                            **precision_args,
                        )[0]
                        verifier = detections_from_result(verifier_result, verifier_names)
                        verifier_ms = float(verifier_result.speed.get("inference", 0.0))

                    fused = fuse_cascade(primary, verifier, cascade_config)
                    decision = postprocessor.process(fused)
                    annotated = draw_postprocessed(frame, decision)
                    inference_ms = float(primary_result.speed.get("inference", 0.0)) + verifier_ms
                    verifier_status = (
                        f"{'ON' if run_verifier else 'skip'} "
                        f"({verifier_runs / processed_frames:.0%})"
                    )
                    alarm = ", ".join(names[index] for index in sorted(decision.active_classes))
                    detection_summary = ", ".join(
                        f"{item.class_name} {item.confidence:.2f}" for item in fused[:4]
                    )
                    logs.append(
                        f"{format_time(position_seconds)} F{frame_number:,} | "
                        f"{len(fused)} det | {inference_ms:.1f}ms | verifier "
                        f"{'ON' if run_verifier else 'skip'}"
                    )
                    player["updating"] = True
                    cv2.setTrackbarPos(TRACKBAR_NAME, window_name, frame_number)
                    player["updating"] = False

            if annotated is not None:
                last_composite = compose_player(
                    annotated,
                    logs,
                    max_video_width=args.display_width,
                    max_video_height=args.display_height,
                    panel_width=args.log_width,
                    paused=bool(player["paused"]),
                    position_seconds=position_seconds,
                    duration_seconds=duration_seconds,
                    frame_number=frame_number,
                    total_frames=total_frames,
                    fps=source_fps,
                    inference_ms=inference_ms,
                    verifier_status=verifier_status,
                    alarm=alarm,
                    detections=detection_summary,
                )
                cv2.imshow(window_name, last_composite)

            elapsed = time.perf_counter() - loop_started
            delay_ms = 30 if player["paused"] else max(1, round((frame_period - elapsed) * 1000))
            key = cv2.waitKeyEx(delay_ms)
            if key < 0:
                continue
            char = key & 0xFF
            if char in (27, ord("q"), ord("Q")):
                break
            if char in (ord(" "), ord("p"), ord("P")):
                player["paused"] = not player["paused"]
                logs.append("PAUSE" if player["paused"] else "RESUME")
                continue

            target: int | None = None
            if char in (ord("a"), ord("A")):
                target = frame_number - round(args.skip_seconds * source_fps)
            elif char in (ord("d"), ord("D")):
                target = frame_number + round(args.skip_seconds * source_fps)
            elif char in (ord("j"), ord("J")):
                target = frame_number - round(args.large_skip_seconds * source_fps)
            elif char in (ord("l"), ord("L")):
                target = frame_number + round(args.large_skip_seconds * source_fps)
            elif char == ord(","):
                player["paused"] = True
                target = frame_number - 1
            elif char == ord("."):
                player["paused"] = True
                target = frame_number + 1
            elif char in (ord("r"), ord("R")):
                target = 0
            elif char in (ord("s"), ord("S")) and last_composite is not None:
                screenshots.mkdir(parents=True, exist_ok=True)
                output = screenshots / f"{source.stem}-{datetime.now():%Y%m%d-%H%M%S}.jpg"
                if cv2.imwrite(str(output), last_composite):
                    logs.append(f"SAVED {output.name}")
                    print(f"screenshot={output}")
                else:
                    logs.append("ERROR: screenshot save failed")
            if target is not None:
                player["seek"] = max(0, min(total_frames - 1, target))
                player["force_read"] = True
    except KeyboardInterrupt:
        print("Interrupted")
    finally:
        capture.release()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
