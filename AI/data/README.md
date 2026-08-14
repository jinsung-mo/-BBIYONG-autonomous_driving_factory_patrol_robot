# Dataset storage

The primary training dataset is **D-Fire**. Dataset binaries are intentionally
not tracked by Git.

- Authoritative project: <https://github.com/gaia-solutions-on-demand/DFireDataset>
- Reproducible download: the ready-to-use Kaggle mirror linked by that project
- Kaggle reference: `sayedgamal99/smoke-fire-detection-yolo`
- Mirror version observed: `2025-01-27T12:37:37.047Z`
- Reported archive size: `3,118,334,483` bytes
- Dataset license: CC0 1.0 Universal
- Classes (preserved from D-Fire): `0: smoke`, `1: fire`

Run `scripts/download_dfire.py`, then `scripts/prepare_dataset.py` as documented
in the parent README. The download script writes a local manifest containing the
actual archive size and SHA-256 digest. Dataset preparation writes a separate
manifest that records every opt-in label correction made in the derived copy.

## Indoor Fire Smoke

The downloaded Indoor Fire Smoke export uses source IDs `0: fire, 1: smoke`,
which are the reverse of the BBIYONG checkpoint contract. Convert the immutable
source ZIP into a separate derived dataset before training:

```powershell
.\.venv\Scripts\python.exe scripts\prepare_indoor_fire_smoke.py
```

The converter preserves the published train/validation/test splits, remaps the
classes to `0: smoke, 1: fire`, records source provenance and per-split counts
in `data/indoor_fire_smoke/preparation_manifest.json`, and runs the standard
dataset validator. Use `--force` only when intentionally replacing that derived
directory.

## FASDD-CV

The FASDD-CV archive contains 95,314 images with COCO, VOC, and TDML
annotations. The preprocessor uses the published COCO train/validation/test
splits and streams only the required image files from the ZIP:

```powershell
.\.venv\Scripts\python.exe scripts\prepare_fasdd_cv.py `
  --sanitize-labels `
  --deduplicate-splits
```

FASDD-CV uses source IDs `0: fire, 1: smoke`. The converter remaps them to the
BBIYONG checkpoint contract `0: smoke, 1: fire` and writes the derived dataset
to `data/fasdd_cv`. The downloaded annotations contain three zero-area boxes
and some boxes that extend one pixel past an image boundary, so corrections
must be explicitly enabled with `--sanitize-labels`. Every dropped or clipped
box is recorded in `data/fasdd_cv/preparation_manifest.json`.

The published FASDD-CV splits also contain byte-identical images under different
filenames. Enable `--deduplicate-splits` to remove cross-split copies while
retaining test images ahead of validation images and validation images ahead of
training images. Each removal and the retained counterpart are recorded in the
same manifest.

When publishing results, cite:

> Pedro Vinicius Almeida Borges de Venancio, Adriano Chaves Lisboa, and Adriano
> Vilela Barbosa. An automatic fire detection system based on deep convolutional
> neural networks for low-power, resource-constrained devices. Neural Computing
> and Applications, 2022.
