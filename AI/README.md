# BBIYONG AI - Fire and Smoke Detection

Training workspace for Jira story `S15P11E101-227`. It downloads, prepares, and
validates the primary D-Fire dataset, trains the candidate models, and keeps
generated data, weights, and run artifacts outside Git.

The phased baseline, domain-adaptation, evaluation, Jetson deployment, and
agent handoff plan is documented in [TRAINING_PLAN.md](TRAINING_PLAN.md).

## Training contract

- Task: object detection
- Classes (D-Fire native order): `0: smoke`, `1: fire`
- Candidate checkpoints: `yolo11n.pt`, `yolo11s.pt`, `yolo26n.pt`
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
  --device 0
```

Train all project candidates sequentially:

```powershell
.\scripts\train_all.ps1 -Epochs 100 -Batch 8
```

Runs are written under `artifacts/runs/<model-name>/`. Compare each run's
`results.csv`, confusion matrix, class metrics, inference latency, and failure
examples. Do not choose a model from training loss alone.

Resume an interrupted run with its last checkpoint:

```powershell
.\.venv\Scripts\python.exe scripts\train.py `
  --resume artifacts\runs\yolo11n\weights\last.pt
```

## Reproducibility notes

- Keep the downloaded D-Fire archive immutable; generate a new derived version
  for annotation fixes or project-specific hard negatives.
- Record dataset version, Git commit, model checkpoint, seed, image size, batch,
  epochs, and GPU for every accepted experiment.
- Negative factory images (red lights, reflections, welding light, steam) are
  important for reducing false alarms.
- Split video-derived frames by source video, not randomly by individual frame.
