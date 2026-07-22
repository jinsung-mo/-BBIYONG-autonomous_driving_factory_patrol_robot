# BBIYONG AI - Fire and Smoke Detection

Training workspace for Jira story `S15P11E101-227`. It downloads, prepares, and
validates the primary D-Fire dataset, trains the candidate models, and keeps
generated data, weights, and run artifacts outside Git.

The phased baseline, domain-adaptation, evaluation, Jetson deployment, and
agent handoff plan is documented in [TRAINING_PLAN.md](TRAINING_PLAN.md).

## Training contract

- Task: object detection
- Classes (D-Fire native order): `0: smoke`, `1: fire`
- Candidate checkpoints: `yolo11n.pt`, `yolo11s.pt`, `yolo26n.pt`, `yolo26s.pt`
- Primary selection metric: validation `mAP50-95`
- Deployment target: Jetson Orin Nano through ONNX and TensorRT
- Primary dataset: D-Fire, using its published train/validation/test split

The repository does not contain the 3+ GB image dataset. D-Fire is downloaded
from the ready-to-use Kaggle mirror linked by the dataset authors. Source,
version, license, size, and citation details are recorded in `data/README.md`.

## Windows setup

Run these commands from `S15P11E101/AI` in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\check_environment.py
```

PyTorch is installed separately so Windows does not accidentally receive a
CPU-only build. If the machine's driver cannot use the CUDA 12.8 wheel, select a
compatible command from the official PyTorch installer.

## 1. Download and prepare D-Fire

Download the versioned public mirror. The command supports resuming an
interrupted `.part` download and records the final SHA-256 digest. Run it from
the `AI` directory:

```powershell
.\.venv\Scripts\python.exe scripts\download_dfire.py
```

The default outputs are:

```text
data/downloads/dfire.zip
data/downloads/dfire.manifest.json
```

Normalize the downloaded archive into the BBIYONG layout:

```powershell
.\.venv\Scripts\python.exe scripts\prepare_dataset.py `
  --source data\downloads\dfire.zip `
  --destination data\fire_smoke `
  --sanitize-labels
```

Preparation verifies and preserves the D-Fire source class IDs without
rewriting label files:

- `0`: `smoke`
- `1`: `fire`

The known mirror contains a small number of invalid zero-area and out-of-range
boxes. `--sanitize-labels` drops zero-area boxes and clips out-of-range boxes to
the image boundary in the derived dataset. Every change is recorded in
`data/fire_smoke/preparation_manifest.json`; the downloaded archive remains
unchanged. The generated `data/fire_smoke/data.yaml` uses the source class
mapping and contains a machine-local absolute dataset path. In YOLO format, the
integer at the start of every annotation row indexes this `names` mapping, so
changing the order without rewriting every annotation would change its meaning.

Validate again at any time:

```powershell
.\.venv\Scripts\python.exe scripts\validate_dataset.py data\fire_smoke\data.yaml
```

Validation fails on malformed/out-of-range boxes, missing required splits, or
identical image bytes crossing split boundaries.

### Negative images

D-Fire includes background images containing neither smoke nor fire. Dataset
preparation copies every supported image, including images without a matching
label file. Ultralytics treats an image with no label file as a valid negative
sample containing zero objects; it does not require a dummy `background`
class. Empty label files also represent zero-object samples. The validator
counts and reports both forms as `negatives`.

Keep negative images in the train and validation splits. They are necessary for
measuring and reducing false detections from clouds, fog, steam, lights,
reflections, and similar visual patterns.

Format reference: [Ultralytics object-detection dataset guide](https://docs.ultralytics.com/datasets/detect/).

Expected normalized layout:

```text
data/fire_smoke/
  data.yaml
  images/train/  images/val/  images/test/
  labels/train/  labels/val/  labels/test/
```

## 2. Smoke-check the installation

This downloads the official tiny COCO8 fixture and a pretrained checkpoint. It
only verifies the environment and training path; it is not a fire/smoke result.

```powershell
.\.venv\Scripts\python.exe scripts\smoke_train.py
```

## 3. Train

Start with one model:

```powershell
.\.venv\Scripts\python.exe scripts\train.py `
  --data data\fire_smoke\data.yaml `
  --model yolo11n.pt `
  --epochs 100 `
  --batch 8 `
  --device 0 `
  --optimizer auto `
  --lr-schedule cosine `
  --warmup-epochs 3 `
  --comparison-split test `
  --augment-preset fire-smoke
```

The default learning-rate policy uses a three-epoch warmup followed by cosine
decay to `1%` of the initial rate. `optimizer=auto` lets the pinned Ultralytics
version select its optimizer and starting rate from the run size; keep epochs
and the common batch size identical across model-comparison runs. Use an
explicit optimizer such as `MuSGD` when `--lr0` must be applied literally.

The `fire-smoke` augmentation preset applies small rotations/translations,
moderate scale and color variation, horizontal flips, reduced mosaic, light
MixUp, and no vertical flips. Available alternatives are `ultralytics` and
`none`. Freeze one preset for all three baseline models; changing it creates a
new experiment rather than a continuation of an existing run.

Before the first optimizer step, the wrapper evaluates the initialized
two-class model on the frozen test split. At training completion it reloads
`best.pt` and evaluates it with the same test data and loading settings, then
prints the before/after losses and metrics together. Normal epoch validation,
early stopping, and `best.pt` selection still use only the validation split.
The temporary test-loader worker pool is closed after each comparison pass so
it does not consume system memory throughout training.
Each run writes:

```text
before_training.json
before_after_evaluation.json
before_after_evaluation.csv
loss_before_after.png
```

This is intentionally evaluated after adapting the pretrained model to the
two-class `smoke`, `fire` head. Evaluating raw COCO class IDs against D-Fire
would not be meaningful. Do not use test results to tune augmentation,
learning rate, stopping, or confidence thresholds; doing so would leak the
holdout into model development. Use `--comparison-split val` for exploratory
runs where test-set access is inappropriate. The extra baseline evaluation can
be disabled for a quick memory-only pilot with `--no-eval-before-train`.

Train all project candidates sequentially:

```powershell
.\scripts\train_all.ps1 -Epochs 100 -Batch 8
```

Runs are written under `artifacts/runs/<model-name>/`. Compare each run's
`results.csv`, confusion matrix, class metrics, inference latency, and failure
examples. Do not choose a model from training loss alone.

After all three runs finish, evaluate their `best.pt` checkpoints on the same
frozen split and produce a single JSON, CSV, and chart comparison:

```powershell
.\.venv\Scripts\python.exe scripts\evaluate_models.py `
  --models `
    yolo11n=artifacts\runs\<experiment>\yolo11n\weights\best.pt `
    yolo11s=artifacts\runs\<experiment>\yolo11s\weights\best.pt `
    yolo26n=artifacts\runs\<experiment>\yolo26n\weights\best.pt `
  --data data\fire_smoke\data.yaml `
  --split test `
  --device 0 `
  --output artifacts\evaluations\<experiment>
```

The output directory must be new so an accepted evaluation cannot be
overwritten. Each model receives its own Ultralytics plots directory, while
`comparison.json`, `comparison.csv`, and `comparison.png` summarize aggregate
and per-class precision, recall, mAP, checkpoint identity, parameter count,
and timing. Use `--split val` during model development; reserve `test` for the
frozen final comparison.

Ultralytics displays live batch progress in the training terminal. At the end
of every epoch, the training wrapper also prints percentage, elapsed time, ETA,
losses, precision, recall, and mAP. Each run stores the latest snapshot in
`progress.json` and append-only history in `progress.jsonl`.

Follow epoch progress from a second PowerShell terminal:

```powershell
Get-Content .\artifacts\runs\baseline-yolo11n\progress.jsonl -Wait
```

Read the latest machine-readable snapshot:

```powershell
Get-Content .\artifacts\runs\baseline-yolo11n\progress.json
```

Resume an interrupted run with its last checkpoint:

```powershell
.\.venv\Scripts\python.exe scripts\train.py `
  --resume artifacts\runs\yolo11n\weights\last.pt
```

## 4. Test a model with the laptop camera

Run a checkpoint on camera index `0`:

```powershell
.\.venv\Scripts\python.exe scripts\camera_inference.py `
  --model yolo11n.pt `
  --camera 0 `
  --device auto
```

Use `Q` or `Esc` to exit and `S` to save an annotated screenshot under
`artifacts/camera/`. If the camera does not open on Windows, retry with
`--backend dshow` or `--backend msmf`, or try another camera index.

The official `yolo11n.pt`, `yolo11s.pt`, and `yolo26n.pt` checkpoints use COCO
classes. They test camera and inference operation but do not detect the project
classes. After training, pass the run's `best.pt` instead:

```powershell
.\.venv\Scripts\python.exe scripts\camera_inference.py `
  --model artifacts\runs\yolo11n\weights\best.pt `
  --camera 0 `
  --device 0 `
  --conf 0.25
```

The script reads class names from the checkpoint and confirms the expected
fine-tuned mapping `0: smoke`, `1: fire` when present.

## Reproducibility notes

- Keep the downloaded D-Fire archive immutable; generate a new derived version
  for annotation fixes or project-specific hard negatives.
- Record dataset version, Git commit, model checkpoint, seed, image size, batch,
  epochs, and GPU for every accepted experiment.
- Negative factory images (red lights, reflections, welding light, steam) are
  important for reducing false alarms.
- Split video-derived frames by source video, not randomly by individual frame.
