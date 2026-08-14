from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import torch
from ultralytics.nn.tasks import load_checkpoint

from training_progress import scalar


METRIC_KEYS = (
    "metrics/precision(B)",
    "metrics/recall(B)",
    "metrics/mAP50(B)",
    "metrics/mAP50-95(B)",
)


def numeric_mapping(values: dict[str, Any]) -> dict[str, float | int | str | bool | None]:
    return {str(key).strip(): scalar(value) for key, value in values.items()}


def read_best_epoch(results_path: Path) -> dict[str, float | int | str]:
    with results_path.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = []
        for raw in csv.DictReader(stream):
            row: dict[str, float | int | str] = {}
            for raw_key, raw_value in raw.items():
                key = str(raw_key).strip()
                value = str(raw_value).strip()
                try:
                    row[key] = float(value)
                except ValueError:
                    row[key] = value
            rows.append(row)
    if not rows:
        raise ValueError(f"Training results contain no epochs: {results_path}")
    ranking_key = "metrics/mAP50-95(B)"
    return max(rows, key=lambda row: float(row.get(ranking_key, float("-inf"))))


def build_comparison(
    before: dict[str, Any], after: dict[str, Any], split: str = "val"
) -> list[dict[str, float | str | None]]:
    comparison: list[dict[str, float | str | None]] = []
    keys = (
        f"{split}/box_loss",
        f"{split}/cls_loss",
        f"{split}/dfl_loss",
        *METRIC_KEYS,
    )
    for key in keys:
        before_value = before.get(key)
        after_value = after.get(key)
        if not isinstance(before_value, (int, float)) or not isinstance(after_value, (int, float)):
            continue
        comparison.append(
            {
                "metric": key,
                "before": float(before_value),
                "after": float(after_value),
                "delta": float(after_value) - float(before_value),
            }
        )
    return comparison


def write_comparison_chart(rows: list[dict[str, Any]], output: Path) -> None:
    losses = [row for row in rows if str(row["metric"]).endswith("_loss")]
    if not losses:
        return
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = [str(row["metric"]).split("/", 1)[-1] for row in losses]
    before = [float(row["before"]) for row in losses]
    after = [float(row["after"]) for row in losses]
    positions = list(range(len(labels)))
    width = 0.36

    figure, axis = plt.subplots(figsize=(8, 5))
    axis.bar([position - width / 2 for position in positions], before, width, label="Before training")
    axis.bar([position + width / 2 for position in positions], after, width, label="Best epoch")
    axis.set_title("Evaluation loss before vs. after training")
    axis.set_ylabel("Loss (lower is better)")
    axis.set_xticks(positions, labels)
    axis.grid(axis="y", alpha=0.25)
    axis.legend()
    figure.tight_layout()
    figure.savefig(output, dpi=160)
    plt.close(figure)


class BeforeAfterEvaluation:
    """Evaluate the initialized two-class model and compare it with the best epoch."""

    def __init__(self, run_baseline: bool = True, comparison_split: str = "test") -> None:
        self.run_baseline = run_baseline
        self.comparison_split = comparison_split
        self.started = False
        self.save_dir: Path | None = None
        self.before_path: Path | None = None
        self.comparison_loader = None

    def _get_comparison_loader(self, trainer):
        if self.comparison_loader is not None:
            return self.comparison_loader
        dataset_path = trainer.data.get(self.comparison_split)
        if not dataset_path:
            raise ValueError(f"Dataset does not define comparison split '{self.comparison_split}'")
        if self.comparison_split == "val":
            self.comparison_loader = trainer.test_loader
            return self.comparison_loader
        batch_size = trainer.batch_size // max(trainer.world_size, 1)
        evaluation_batch = batch_size if trainer.args.task in {"obb", "semantic"} else batch_size * 2
        self.comparison_loader = trainer.get_dataloader(
            dataset_path,
            batch_size=evaluation_batch,
            rank=-1,
            mode="val",
        )
        return self.comparison_loader

    def _release_comparison_loader(self) -> None:
        """Release custom test workers between the two comparison passes."""
        if self.comparison_split == "val" or self.comparison_loader is None:
            return
        close = getattr(self.comparison_loader, "close", None)
        if callable(close):
            close()
        self.comparison_loader = None

    def _evaluate(self, trainer, model_override=None) -> tuple[dict[str, Any], Any]:
        validator = trainer.validator
        previous_loader = validator.dataloader
        previous_split = validator.args.split
        previous_plots = validator.args.plots
        previous_ema = trainer.ema.ema
        try:
            validator.dataloader = self._get_comparison_loader(trainer)
            validator.args.split = self.comparison_split
            validator.args.plots = False
            if model_override is not None:
                trainer.ema.ema = model_override
            metrics = dict(validator(trainer) or {})
        finally:
            trainer.ema.ema = previous_ema
            validator.dataloader = previous_loader
            validator.args.split = previous_split
            validator.args.plots = previous_plots
            self._release_comparison_loader()
        fitness = metrics.pop("fitness", None)
        renamed = {}
        for key, value in metrics.items():
            output_key = (
                f"{self.comparison_split}/{key.removeprefix('val/')}"
                if key.startswith("val/")
                else key
            )
            renamed[output_key] = value
        return renamed, fitness

    def on_train_epoch_start(self, trainer) -> None:
        if self.started:
            return
        self.started = True
        self.save_dir = Path(trainer.save_dir)
        self.before_path = self.save_dir / "before_training.json"
        if not self.run_baseline:
            if self.before_path.is_file():
                print(f"[evaluation] using existing baseline={self.before_path}", flush=True)
            else:
                print("[evaluation] WARNING: no before-training baseline exists for this resumed run", flush=True)
            return

        print(
            f"[evaluation] evaluating initialized two-class model on split={self.comparison_split} "
            "before the first optimizer step...",
            flush=True,
        )
        # Ultralytics normally creates loss_items during the first training
        # forward pass. Baseline validation intentionally runs before that pass.
        if not hasattr(trainer, "loss_items"):
            trainer.loss_items = torch.zeros(len(trainer.loss_names), device=trainer.device)
        metrics, fitness = self._evaluate(trainer)
        record = {
            "definition": (
                "Pretrained weights loaded into the initialized two-class smoke/fire model, "
                f"evaluated on {self.comparison_split} before the first optimizer step"
            ),
            "split": self.comparison_split,
            "fitness": scalar(fitness),
            "metrics": numeric_mapping(metrics or {}),
        }
        self.before_path.write_text(
            json.dumps(record, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"[evaluation] before_training={self.before_path}", flush=True)

    def on_train_end(self, trainer) -> None:
        save_dir = self.save_dir or Path(trainer.save_dir)
        before_path = self.before_path or save_dir / "before_training.json"
        results_path = save_dir / "results.csv"
        if not before_path.is_file() or not results_path.is_file():
            print("[evaluation] WARNING: before/after report skipped because required artifacts are missing", flush=True)
            return

        before_record = json.loads(before_path.read_text(encoding="utf-8"))
        before_metrics = numeric_mapping(before_record.get("metrics", {}))
        best_epoch = read_best_epoch(results_path)
        best_model, _ = load_checkpoint(trainer.best, device=trainer.device, fuse=False)
        # A standalone checkpoint stores model.args as a plain dict. Trainer-mode
        # validation computes losses and expects the attribute-style trainer args.
        best_model.args = trainer.args
        if hasattr(best_model, "criterion"):
            delattr(best_model, "criterion")
        after_metrics_raw, after_fitness = self._evaluate(trainer, model_override=best_model)
        after_metrics = numeric_mapping(after_metrics_raw)
        comparison = build_comparison(
            before_metrics,
            after_metrics,
            split=self.comparison_split,
        )
        report = {
            "comparison_split": self.comparison_split,
            "before_definition": before_record.get("definition"),
            "after_definition": (
                f"best.pt evaluated on the same {self.comparison_split} split; "
                "checkpoint selected using validation data"
            ),
            "best_epoch": int(float(best_epoch.get("epoch", 0))),
            "after_fitness": scalar(after_fitness),
            "before": before_metrics,
            "after": after_metrics,
            "comparison": comparison,
        }
        report_path = save_dir / "before_after_evaluation.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        csv_path = save_dir / "before_after_evaluation.csv"
        with csv_path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=("metric", "before", "after", "delta"))
            writer.writeheader()
            writer.writerows(comparison)
        chart_path = save_dir / "loss_before_after.png"
        write_comparison_chart(comparison, chart_path)

        print("\n[evaluation] before vs. best epoch", flush=True)
        print(f"{'metric':<28} {'before':>12} {'after':>12} {'delta':>12}", flush=True)
        for row in comparison:
            print(
                f"{row['metric']:<28} {row['before']:>12.5g} "
                f"{row['after']:>12.5g} {row['delta']:>+12.5g}",
                flush=True,
            )
        print(f"[evaluation] report={report_path}", flush=True)
        print(f"[evaluation] loss_chart={chart_path}", flush=True)


def attach_before_after_evaluation(
    model,
    run_baseline: bool = True,
    comparison_split: str = "test",
) -> BeforeAfterEvaluation:
    evaluation = BeforeAfterEvaluation(
        run_baseline=run_baseline,
        comparison_split=comparison_split,
    )
    # trainer.epoch exists here, but no training batch or optimizer step has run.
    model.add_callback("on_train_epoch_start", evaluation.on_train_epoch_start)
    model.add_callback("on_train_end", evaluation.on_train_end)
    return evaluation
