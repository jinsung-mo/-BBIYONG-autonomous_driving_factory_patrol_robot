# BBIYONG AI - Fire and Smoke Detection

Training workspace for Jira story `S15P11E101-15`. It downloads, prepares, and
validates the primary D-Fire dataset, trains the candidate models, and keeps
generated data, weights, and run artifacts outside Git.

## Training contract

- Task: object detection
- Classes: `0: fire`, `1: smoke`
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
interrupted `.part` download and records the final SHA-256 digest.

```powershell
.\.venv\Scripts\python.exe scripts\download_dfire.py
```

Normalize the downloaded archive into the BBIYONG layout:

```powershell
.\.venv\Scripts\python.exe scripts\prepare_dataset.py `
  --source data\downloads\dfire.zip `
  --destination data\fire_smoke
```

Preparation verifies/remaps the source class order to the canonical BBIYONG
order `fire`, `smoke`. It writes `data/fire_smoke/data.yaml` with a machine-local
absolute path.

Validate again at any time:

```powershell
.\.venv\Scripts\python.exe scripts\validate_dataset.py data\fire_smoke\data.yaml
```

Validation fails on malformed/out-of-range boxes, missing required splits,
or identical image bytes crossing split boundaries. Images without label files
are allowed and reported as negatives.

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
