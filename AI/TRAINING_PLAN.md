# Fire and Smoke Detection Training and Deployment Plan

Status: planned work

Owner scope: `AI/`

Target branch: `ai/main` through the current AI feature branch

Last reviewed: 2026-07-21

## 1. Objective

Build and select a fire/smoke detector for the BBIYONG factory patrol robot by
training `yolo11n.pt`, `yolo11s.pt`, and `yolo26n.pt` on the same frozen D-Fire
dataset, then evaluating the strongest candidates on factory video and the
Jetson Orin Nano.

The selected system must detect early smoke reliably, control false alarms in
normal factory operation, and meet the robot's sustained edge-inference budget.
COCO benchmark results are useful priors, not selection evidence for this task.

## 2. Non-negotiable data contract

- Task: YOLO object detection.
- Preserve the D-Fire source mapping: `0 = smoke`, `1 = fire`.
- Do not add a `background` class.
- An image with no objects may have no label file or an empty label file.
- Never edit the downloaded archive. All corrections create a new derived
  dataset version.
- Keep the published source split for the first baseline.
- Split later video-derived data by source video, camera, location, and
  recording session—not by individual frame.
- Keep a factory holdout set that is never used for training, threshold tuning,
  augmentation decisions, or model selection.

The annotation row format is:

```text
class_id x_center y_center width height
```

Coordinates are normalized to `0..1`, and `class_id` indexes the `names`
mapping in `data.yaml`.

## 3. Current repository state

As verified on 2026-07-21:

- Python 3.12.12, PyTorch 2.11.0+cu128, and Ultralytics 8.4.102 load correctly.
- CUDA is available on an RTX 4070 Laptop GPU with 8 GiB VRAM.
- `yolo11n.pt` and `yolo26n.pt` are present and load correctly.
- `yolo11s.pt` is not present locally and must be acquired before the frozen
  experiment begins.
- D-Fire has not been downloaded or prepared.
- Dataset preparation preserves D-Fire IDs and copies negative images.
- The validator checks split presence, label shape, class range, normalized
  coordinates, and exact duplicate image bytes crossing splits.
- Four dataset tests pass.
- Training currently exposes model, data, epochs, image size, batch size,
  device, workers, seed, output name, and resume checkpoint. Cache mode,
  periodic checkpoints, custom augmentation, standalone evaluation, export,
  and Jetson benchmarking are not implemented in repository scripts yet.

## 4. Success criteria

Model selection is a constrained safety decision, not a single-metric ranking.

### Primary quality criteria

1. Smoke recall on the frozen public test set.
2. Smoke recall and detection delay on the factory holdout videos.
3. Fire recall on both test sets.
4. False-alarm events per hour on negative factory videos.

### Deployment constraints

- Sustained Jetson throughput and latency target: define with the robotics team
  before final selection. Until then, report results without inventing a pass
  threshold.
- Report median and P95 end-to-end latency at batch 1.
- Report preprocessing, inference, and postprocessing separately.
- Report peak memory, temperature, power mode, and thermal throttling during a
  minimum 30-minute run.
- Final acceptance requires an FP16 TensorRT engine tested on the target Jetson.

### Supporting metrics

- Per-class precision, recall, AP50, and AP50-95.
- Negative-image false-positive rate at the locked operating threshold.
- Model size and parameter count.
- Alarm-event precision and recall after temporal filtering.

## 5. Experiment rules

For the initial model comparison, freeze all variables except model
architecture:

- Dataset archive digest and derived dataset manifest.
- Train/validation/test membership.
- Image size: `640`.
- Epoch ceiling: `100` for the first baseline.
- Patience: `30`.
- Seed: `42`.
- Deterministic mode: enabled.
- Augmentation policy.
- Learning-rate schedule, optimizer policy, and warmup.
- Evaluation code and confidence-threshold selection method.
- Before-training and final `best.pt` comparison on one fixed split and loader.
- Hardware and software environment.

Use one explicit batch size that fits all three models. Do not use `batch=-1`
for the comparison because it can choose a different batch size per model. Run
a short memory pilot to choose the common batch, then freeze it.

The first pass may use one seed to control cost. After ranking, retrain the top
two candidates with two additional seeds and report mean, standard deviation,
and worst result for the primary metrics. Do not promote a model based on one
lucky run.

## 6. Phased execution plan

### Phase 0 — Record decisions and target constraints

Tasks:

- Confirm the exact Jetson SKU, RAM, JetPack, CUDA, and TensorRT versions.
- Confirm camera resolution, codec, expected input rate, and whether inference
  shares the GPU with other robot workloads.
- Agree on minimum smoke/fire recall, maximum false alarms per hour, and latency
  budget with the safety and robotics owners.
- Define one false-alarm event. Initial proposal: detections separated by less
  than five seconds count as one continuous event.
- Define visible-onset timestamps for controlled positive videos.

Exit gate:

- Constraints are written into an experiment record; unresolved values are
  explicitly marked `TBD` and are not silently converted into pass criteria.

### Phase 1 — Acquire, prepare, audit, and freeze D-Fire

Run from `S15P11E101/AI`:

```powershell
.\.venv\Scripts\python.exe scripts\download_dfire.py

.\.venv\Scripts\python.exe scripts\prepare_dataset.py `
  --source data\downloads\dfire.zip `
  --destination data\fire_smoke `
  --sanitize-labels

.\.venv\Scripts\python.exe scripts\validate_dataset.py `
  data\fire_smoke\data.yaml
```

Expected locations:

```text
data/downloads/dfire.zip
data/downloads/dfire.manifest.json
data/fire_smoke/data.yaml
```

Required audit:

- Verify archive SHA-256 and record mirror version and license.
- Verify `names` is exactly `{0: smoke, 1: fire}`.
- Record image, labeled-image, negative-image, box, and per-class counts for
  each split.
- Inspect a stratified visual sample containing smoke, fire, both classes,
  negatives, small objects, night scenes, and difficult weather/lighting.
- Review warnings for missing labels and orphan labels.
- Review `preparation_manifest.json` and visually inspect every dropped or
  clipped annotation.
- Extend dataset fingerprinting to record every relative path and file digest,
  not only cross-split duplicate detection.
- Save the fingerprint and validation report under a versioned artifact path.

Exit gate:

- Validation has no errors, class IDs are confirmed visually, the split is
  frozen, and the dataset fingerprint is recorded.

### Phase 2 — Make experiments reproducible

Implement before the full three-model run:

- Add a machine-readable experiment configuration or manifest.
- Record Git commit, dirty-tree state, checkpoint SHA-256, dataset fingerprint,
  Python/package versions, CUDA version, GPU, seed, and all resolved training
  arguments.
- Add explicit support for cache mode and periodic checkpoint frequency only if
  they are needed; do not rely on commands the current wrapper cannot parse.
- Prevent accidental reuse or overwrite of an existing run directory.
- Add standalone test-set evaluation that writes JSON/CSV summary metrics.
- Add a threshold-sweep utility using validation data only.
- Add tests for every new argument and artifact contract.

Suggested run layout:

```text
artifacts/
  datasets/<dataset-id>/
  runs/<experiment-id>/<model>/
  evaluations/<experiment-id>/<model>/
  exports/<experiment-id>/<model>/
  benchmarks/<experiment-id>/<model>/
```

Exit gate:

- A one-epoch run can be reproduced from its manifest without guessing any
  input, weight, setting, or environment version.

### Phase 3 — Pilot and baseline training

1. Acquire and checksum `yolo11s.pt` before freezing the experiment.
2. Run a one-epoch smoke test for all three checkpoints.
3. Run a short batch-size pilot and choose the largest common stable batch.
4. Train the three models sequentially with identical frozen settings:
   `yolo11n`, `yolo11s`, then `yolo26n`.
5. Preserve `last.pt`, `best.pt`, `results.csv`, plots, logs, and the manifest.
6. Resume interrupted runs only from their own `last.pt`; do not restart into
   the same output directory with different settings.

Current command shape:

```powershell
.\.venv\Scripts\python.exe scripts\train.py `
  --data data\fire_smoke\data.yaml `
  --model yolo11n.pt `
  --epochs 100 `
  --imgsz 640 `
  --batch 8 `
  --device 0 `
  --seed 42 `
  --optimizer auto `
  --lr-schedule cosine `
  --warmup-epochs 3 `
  --comparison-split test `
  --augment-preset fire-smoke `
  --name baseline-yolo11n
```

Replace `--batch 8` only after the common-batch pilot. Repeat with unique names
for `yolo11s.pt` and `yolo26n.pt`.

Exit gate:

- Three complete, non-overlapping runs exist with matching dataset and
  experiment settings, and all expected artifacts are readable.

### Phase 4 — Frozen image-level evaluation

Evaluation procedure:

1. The training wrapper may evaluate the initialized two-class model and the
   final `best.pt` on the same frozen D-Fire test loader for a paired
   before/after report. This report must not feed training, checkpoint
   selection, or hyperparameter decisions.
2. Use validation data to sweep confidence thresholds separately for smoke and
   fire if the runtime permits per-class thresholds.
3. Select and lock the operating thresholds using the agreed safety objective.
4. Evaluate the locked candidate on the frozen D-Fire test split.
5. Produce per-class metrics, confusion matrices, false positives on negatives,
   and a curated failure gallery.
6. Compare models using the same evaluation implementation and thresholds
   selected by the same rule.

Required comparison table:

| Model | Smoke R | Fire R | Smoke P | Fire P | mAP50-95 | Negative FPR | Params |
|---|---:|---:|---:|---:|---:|---:|---:|
| YOLO11n | | | | | | | |
| YOLO11s | | | | | | | |
| YOLO26n | | | | | | | |

Exit gate:

- The ranking is reproducible and every metric links to its model, dataset,
  threshold, and evaluation manifest.

### Phase 5 — Factory-domain dataset and video evaluation

Collect normal patrol video from the actual camera height, lens, codec,
lighting, motion, and robot speed. Include hard negatives such as welding,
steam, dust, exhaust, indicator lamps, orange clothing, reflections, sunlight,
motion blur, dirty/fogged lenses, and emergency lighting.

Positive footage must come from approved controlled sources. Do not create an
uncontrolled fire. Smoke-machine or supervised training footage is preferred;
synthetic compositing may supplement but must not replace real validation.

Data rules:

- Store source/session metadata before extracting frames.
- Deduplicate within and across public/factory sources.
- Split by recording session and physical location.
- Keep the factory holdout immutable.
- Version annotation guidelines and review ambiguous smoke boundaries.

Video metrics:

- Detection delay = first accepted alarm time minus visible-onset time.
- False alarms per hour = false alarm events divided by negative-video hours.
- Report missed events, fragmented alarms, and confidence stability.

Exit gate:

- At least one representative factory holdout suite exists with reviewed onset
  timestamps and event labels; all three baselines have been evaluated on it.

### Phase 6 — Domain adaptation

First compare:

1. D-Fire only.
2. D-Fire plus factory hard negatives.
3. D-Fire plus factory negatives and approved factory positives.

Fine-tune the top two baseline architectures, not all models indefinitely. Use
the public-data `best.pt` as initialization, lower the learning rate, and keep
the factory holdout untouched.

Secondary public datasets such as FASDD are optional. Before ingestion, require
a written license/provenance decision, class-definition audit, duplicate/source
overlap scan, annotation-quality review, and a source-grouped split. Do not
merge a large dataset merely because it is available. Datasets with
noncommercial or unclear terms must not enter a production candidate without
owner approval.

Exit gate:

- Domain adaptation improves factory holdout safety metrics without an
  unacceptable regression on the frozen public test set.

### Phase 7 — Export and Jetson benchmark

For the top two models:

1. Export ONNX on the training machine and run numerical/parity checks.
2. Build FP16 TensorRT engines in the target Jetson environment.
3. Verify output class mapping and confidence parity on a fixed image suite.
4. Benchmark the same decoded video, resolution, batch size, thresholds, power
   mode, clocks, and measurement window.
5. Disable display rendering during measurements.
6. Warm up at least 100 frames; measure at least 1,000 frames and run a separate
   30-minute sustained test.

Record:

- Jetson SKU, JetPack, CUDA, cuDNN, TensorRT, Ultralytics, and engine digest.
- Precision, input shape, batch, and YOLO26 `end2end` mode.
- Decode/preprocess, inference, postprocess, and total latency.
- Median, P95, P99, FPS, peak memory, GPU utilization, power, and temperature.
- Any throttling, dropped frames, or camera-pipeline backpressure.

YOLO26 defaults to its one-to-one end-to-end head, while YOLO11 normally uses
NMS. Benchmark full pipeline latency, not inference alone. If testing YOLO26's
one-to-many head, record it as a separate variant rather than silently changing
the baseline.

TensorRT engines are environment-specific. Build and validate them on the
actual deployment target. Start with FP16. Test INT8 only after FP16 passes;
use representative factory calibration data and reject INT8 if smoke recall,
detection delay, or confidence stability degrades beyond the agreed limit.

Exit gate:

- At least one model passes both quality and sustained Jetson constraints with
  a reproducible FP16 engine and benchmark report.

### Phase 8 — Temporal alarm and thermal fusion

Treat detector selection and alarm-policy tuning as separate experiments.

Initial policy candidates:

- Warning: smoke exceeds its threshold in 4 of 10 frames.
- Alarm: smoke exceeds its threshold in 7 of 10 frames.
- Critical: confirmed fire plus an independent thermal condition.

Tune windows, counts, thresholds, and event cooldown on validation videos only.
Evaluate the locked policy on the factory holdout. Define behavior for stale
thermal data, camera loss, disagreement between RGB and thermal inputs, and
sensor recovery. A thermal signal may increase confidence but must not conceal
an RGB detector failure.

Exit gate:

- The alarm state machine has unit tests, timestamped replay tests, and measured
  event-level recall, false alarms per hour, and detection delay.

## 7. Decision matrix

Do not preselect YOLO26n. Use this decision order:

1. Reject models that fail minimum smoke or fire recall.
2. Reject models that exceed the false-alarm budget.
3. Reject models that fail sustained Jetson latency, memory, power, or thermal
   constraints.
4. Among remaining models, prefer lower smoke detection delay.
5. Use mAP50-95, model size, and implementation complexity as tie-breakers.

Expected roles, not conclusions:

| Model | Working hypothesis |
|---|---|
| YOLO11n | Stable lightweight baseline |
| YOLO11s | Accuracy-oriented candidate with higher compute cost |
| YOLO26n | Edge-oriented candidate with native end-to-end inference |

## 8. Agent execution protocol

Every future agent working this plan must:

1. Read `AI/README.md`, this plan, the relevant scripts, and current Git status.
2. Preserve unrelated user changes and work on the current AI feature/target
   branch unless explicitly instructed otherwise.
3. State the phase and exit gate being addressed before changing files.
4. Inspect existing artifacts before downloading, preparing, training, or
   exporting anything.
5. Obtain explicit authorization before a multi-gigabyte download, long GPU
   training run, target-device power-mode change, or other externally costly or
   privileged action unless the user's request already authorizes it.
6. Never modify or delete the immutable source archive or an accepted holdout.
7. Use unique run directories; do not overwrite accepted results.
8. Validate class IDs after every conversion or dataset merge.
9. Run proportionate tests and report exact commands, exit status, and artifact
   locations.
10. Update the experiment manifest and this document's status when a phase gate
    is actually completed.

An agent handoff must include:

- Completed phase/task and evidence.
- Files and artifacts created or changed.
- Dataset/model/engine digests involved.
- Tests and evaluations run, including failures.
- Open risks, assumptions, and the exact next gate.
- Whether the working tree is dirty and whether anything was committed.

## 9. Immediate backlog

Execute in this order:

- [ ] Confirm Jetson hardware/software and operational acceptance thresholds.
- [ ] Download D-Fire and record its archive manifest.
- [ ] Prepare and validate `data/fire_smoke`.
- [ ] Add full dataset fingerprint and persisted validation report.
- [ ] Acquire and checksum `yolo11s.pt`.
- [ ] Add experiment-manifest support.
- [ ] Add standalone threshold sweep and test evaluation.
- [ ] Run three one-epoch smoke tests.
- [ ] Freeze the common batch size and baseline configuration.
- [ ] Train the three 640-pixel baselines.
- [ ] Evaluate on D-Fire and create the failure gallery.
- [ ] Define and collect the factory holdout suite.
- [ ] Evaluate video-level delay and false alarms.
- [ ] Fine-tune the top two candidates with factory-domain data.
- [ ] Export and benchmark FP16 TensorRT on the target Jetson.
- [ ] Evaluate temporal alarm and thermal-fusion policy.
- [ ] Consider INT8 or additional public datasets only after baseline gates pass.

## 10. References

- [D-Fire repository](https://github.com/gaia-solutions-on-demand/DFireDataset)
- [Ultralytics detection dataset format](https://docs.ultralytics.com/datasets/detect/)
- [Ultralytics train settings](https://docs.ultralytics.com/modes/train/)
- [Ultralytics YOLO11](https://docs.ultralytics.com/models/yolo11/)
- [Ultralytics YOLO26](https://docs.ultralytics.com/models/yolo26/)
- [Ultralytics TensorRT integration](https://docs.ultralytics.com/integrations/tensorrt/)
- [Ultralytics Jetson guide](https://docs.ultralytics.com/guides/nvidia-jetson/)
- [FASDD project](https://github.com/openrsgis/FASDD)
