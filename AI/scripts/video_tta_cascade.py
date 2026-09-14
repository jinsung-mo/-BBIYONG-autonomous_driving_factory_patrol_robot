from __future__ import annotations

import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO

from camera_inference import FIRE_SMOKE_NAMES, draw_postprocessed, normalized_names, resolve_device, resolve_model
from cascade import CascadeConfig, fuse_cascade
from evaluate_tta_consensus import consensus, restore_flip, views
from postprocessing import ClassPolicy, FireSmokePostprocessor, PostprocessConfig, TemporalPolicy, detections_from_result


AI_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render YOLO11n + four-view YOLO11s TTA cascade boxes and temporal alarms on a video"
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--model", default="artifacts/runs/dfire-v1-640-b56-seed42/yolo11n-2/weights/best.pt")
    parser.add_argument("--verifier-model", default="artifacts/runs/dfire-v1-640-b56-seed42/yolo11s/weights/best.pt")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--candidate-conf", type=float, default=0.001)
    parser.add_argument("--nms-iou", type=float, default=0.70)
    parser.add_argument("--max-det", type=int, default=300)
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--min-votes", type=int, default=4)
    parser.add_argument("--tta-agreement-iou", type=float, default=0.60)
    parser.add_argument("--high-conf-smoke", type=float, default=0.65)
    parser.add_argument("--high-conf-fire", type=float, default=0.75)
    parser.add_argument("--verify-low", type=float, default=0.15)
    parser.add_argument("--verify-high", type=float, default=0.60)
    parser.add_argument("--primary-conf", type=float, default=0.35)
    parser.add_argument("--cascade-agreement-iou", type=float, default=0.50)
    parser.add_argument("--verifier-only-conf", type=float, default=0.70)
    parser.add_argument("--final-nms-iou", type=float, default=0.35)
    parser.add_argument("--smoke-threshold", type=float, default=0.14)
    parser.add_argument("--fire-threshold", type=float, default=0.18)
    parser.add_argument("--temporal-window", type=int, default=5)
    parser.add_argument("--temporal-hits", type=int, default=3)
    parser.add_argument("--display-width", type=int, default=960)
    parser.add_argument("--display-height", type=int, default=720)
    parser.add_argument("--no-display", action="store_true", help="Write the annotated MP4 without opening a preview window")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Video not found: {source}")
    if output.exists():
        raise SystemExit(f"Output already exists: {output}")
    if not 1 <= args.min_votes <= 4:
        raise SystemExit("min-votes must be between 1 and 4")
    if not 1 <= args.temporal_hits <= args.temporal_window:
        raise SystemExit("temporal-hits must be between 1 and temporal-window")
    if args.display_width < 1 or args.display_height < 1:
        raise SystemExit("display dimensions must be positive")

    device = resolve_device(args.device)
    if args.half and device == "cpu":
        raise SystemExit("--half requires a CUDA device")
    primary_model = YOLO(resolve_model(args.model))
    verifier_model = YOLO(resolve_model(args.verifier_model))
    primary_names = normalized_names(primary_model)
    verifier_names = normalized_names(verifier_model)
    if primary_names != FIRE_SMOKE_NAMES or verifier_names != FIRE_SMOKE_NAMES:
        raise SystemExit("Both checkpoints must use classes 0: smoke, 1: fire")

    tta_settings = argparse.Namespace(
        min_votes=args.min_votes,
        agreement_iou=args.tta_agreement_iou,
        high_conf_smoke=args.high_conf_smoke,
        high_conf_fire=args.high_conf_fire,
        dark_gamma=1.20,
        bright_gamma=0.80,
    )
    cascade_settings = CascadeConfig(
        verify_low=args.verify_low,
        verify_high=args.verify_high,
        primary_confidence=args.primary_conf,
        agreement_iou=args.cascade_agreement_iou,
        verifier_only_confidence=args.verifier_only_conf,
        final_nms_iou=args.final_nms_iou,
        verifier_interval=1,
    )
    cascade_settings.validate()
    postprocessor = FireSmokePostprocessor(
        PostprocessConfig(
            classes={
                0: ClassPolicy(threshold=args.smoke_threshold, hold_threshold=args.smoke_threshold),
                1: ClassPolicy(threshold=args.fire_threshold, hold_threshold=args.fire_threshold),
            },
            temporal=TemporalPolicy(window=args.temporal_window, min_hits=args.temporal_hits),
            candidate_confidence=args.candidate_conf,
            nms_iou=args.nms_iou,
            max_det=args.max_det,
        )
    )
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise SystemExit(f"Could not open video: {source}")
    fps = float(capture.get(cv2.CAP_PROP_FPS)) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    output.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise SystemExit(f"Could not create output: {output}")

    print(f"[tta-video] source={source.name} frames={total} fps={fps:.2f}")
    print("[tta-video] TTA is four YOLO11s views per frame, so preview is not real-time. Press Q to stop.")
    precision_args = {"half": True} if args.half else {}
    frame_index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            primary_result = primary_model.predict(
                source=frame, imgsz=args.imgsz, conf=args.candidate_conf, iou=args.nms_iou,
                max_det=args.max_det, device=device, verbose=False, **precision_args,
            )[0]
            primary = detections_from_result(primary_result, primary_names)
            tta_detections = []
            for view_id, (name, view) in enumerate(views(frame, tta_settings)):
                result = verifier_model.predict(
                    source=view, imgsz=args.imgsz, conf=args.candidate_conf, iou=args.nms_iou,
                    max_det=args.max_det, device=device, verbose=False, **precision_args,
                )[0]
                for item in detections_from_result(result, verifier_names):
                    tta_detections.append((view_id, restore_flip(item, width) if name == "flip" else item))
            fused = fuse_cascade(primary, consensus(tta_detections, tta_settings), cascade_settings)
            decision = postprocessor.process(fused)
            annotated = draw_postprocessed(frame, decision)
            status = f"TTA-cascade | frame {frame_index}/{max(total - 1, 0)} | alarm: "
            status += ", ".join(FIRE_SMOKE_NAMES[index] for index in sorted(decision.active_classes)) or "none"
            cv2.putText(annotated, status, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 2, cv2.LINE_AA)
            writer.write(annotated)
            if not args.no_display:
                scale = min(
                    args.display_width / width,
                    args.display_height / height,
                    1.0,
                )
                preview = (
                    cv2.resize(
                        annotated,
                        (round(width * scale), round(height * scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                    if scale < 1.0
                    else annotated
                )
                cv2.imshow("BBIYONG TTA-cascade", preview)
                if (cv2.waitKey(1) & 0xFF) in (ord("q"), ord("Q")):
                    break
            frame_index += 1
            if frame_index % 30 == 0 or frame_index == total:
                print(f"[tta-video] {frame_index}/{total}", flush=True)
    finally:
        capture.release()
        writer.release()
        if not args.no_display:
            cv2.destroyAllWindows()
    print(f"[tta-video] output={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
