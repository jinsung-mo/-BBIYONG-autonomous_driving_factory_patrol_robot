from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def scalar(value: Any) -> float | int | str | bool | None:
    if value is None or isinstance(value, (str, bool)):
        return value
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    try:
        number = float(value)
        return number if math.isfinite(number) else str(number)
    except (TypeError, ValueError):
        return str(value)


def format_duration(seconds: float | None) -> str:
    if seconds is None or not math.isfinite(seconds) or seconds < 0:
        return "unknown"
    rounded = int(round(seconds))
    hours, remainder = divmod(rounded, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


class TrainingProgress:
    """Report epoch progress to the console and durable JSON/JSONL files."""

    def __init__(self) -> None:
        self.started_monotonic: float | None = None
        self.initial_epoch = 0
        self.snapshot_path: Path | None = None
        self.history_path: Path | None = None
        self.latest: dict[str, Any] = {}

    def on_train_start(self, trainer) -> None:
        self.started_monotonic = time.monotonic()
        self.initial_epoch = int(getattr(trainer, "start_epoch", 0))
        save_dir = Path(trainer.save_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
        self.snapshot_path = save_dir / "progress.json"
        self.history_path = save_dir / "progress.jsonl"
        self.latest = self._record(trainer, status="training", include_metrics=False)
        self._write(self.latest)
        print(
            f"[progress] started epochs={trainer.epochs} start_epoch={self.initial_epoch + 1} "
            f"snapshot={self.snapshot_path}",
            flush=True,
        )

    def on_fit_epoch_end(self, trainer) -> None:
        # Ultralytics emits this callback once more after final best.pt validation
        # with epoch temporarily incremented. on_train_end records that final state.
        if int(getattr(trainer, "epoch", 0)) >= int(getattr(trainer, "epochs", 0)):
            return
        self.latest = self._record(trainer, status="training", include_metrics=True)
        self._write(self.latest)
        metrics = self.latest.get("metrics", {})
        preferred = (
            "train/box_loss",
            "train/cls_loss",
            "train/dfl_loss",
            "metrics/precision(B)",
            "metrics/recall(B)",
            "metrics/mAP50(B)",
            "metrics/mAP50-95(B)",
        )
        summary = " ".join(
            f"{key.split('/')[-1]}={metrics[key]:.4g}"
            for key in preferred
            if isinstance(metrics.get(key), (int, float))
        )
        print(
            f"[progress] epoch {self.latest['epoch_completed']}/{self.latest['epochs_total']} "
            f"({self.latest['percent']:.1f}%) elapsed={self.latest['elapsed']} "
            f"eta={self.latest['eta']} {summary}".rstrip(),
            flush=True,
        )

    def on_train_end(self, trainer) -> None:
        self.latest = self._record(trainer, status="complete", include_metrics=True)
        self._write(self.latest)
        print(
            f"[progress] complete epochs={self.latest['epoch_completed']} "
            f"elapsed={self.latest['elapsed']}",
            flush=True,
        )

    def _record(self, trainer, status: str, include_metrics: bool) -> dict[str, Any]:
        total = int(getattr(trainer, "epochs", 0))
        current_epoch = int(getattr(trainer, "epoch", self.initial_epoch - 1))
        completed = max(self.initial_epoch, current_epoch + 1) if include_metrics else self.initial_epoch
        elapsed_seconds = (
            max(0.0, time.monotonic() - self.started_monotonic)
            if self.started_monotonic is not None
            else 0.0
        )
        epochs_this_session = max(0, completed - self.initial_epoch)
        eta_seconds: float | None = None
        if epochs_this_session and completed < total:
            average = elapsed_seconds / epochs_this_session
            eta_seconds = average * (total - completed)

        metrics: dict[str, Any] = {}
        if include_metrics:
            tloss = getattr(trainer, "tloss", None)
            if tloss is not None:
                metrics.update(trainer.label_loss_items(tloss))
            metrics.update(getattr(trainer, "metrics", {}) or {})
            metrics.update(getattr(trainer, "lr", {}) or {})
            metrics = {str(key): scalar(value) for key, value in metrics.items()}

        return {
            "status": status,
            "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            "run_directory": str(Path(trainer.save_dir).resolve()),
            "epoch_completed": completed,
            "epochs_total": total,
            "percent": round((completed * 100.0 / total) if total else 0.0, 2),
            "elapsed_seconds": round(elapsed_seconds, 3),
            "elapsed": format_duration(elapsed_seconds),
            "eta_seconds": round(eta_seconds, 3) if eta_seconds is not None else None,
            "eta": format_duration(eta_seconds),
            "metrics": metrics,
        }

    def _write(self, record: dict[str, Any]) -> None:
        if self.snapshot_path is None or self.history_path is None:
            return
        serialized = json.dumps(record, ensure_ascii=False, sort_keys=True)
        temporary = self.snapshot_path.with_suffix(".json.tmp")
        temporary.write_text(serialized + "\n", encoding="utf-8")
        temporary.replace(self.snapshot_path)
        with self.history_path.open("a", encoding="utf-8") as stream:
            stream.write(serialized + "\n")


def attach_progress_callbacks(model) -> TrainingProgress:
    progress = TrainingProgress()
    model.add_callback("on_train_start", progress.on_train_start)
    model.add_callback("on_fit_epoch_end", progress.on_fit_epoch_end)
    model.add_callback("on_train_end", progress.on_train_end)
    return progress
