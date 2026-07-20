# Dataset storage

The primary training dataset is **D-Fire**. Dataset binaries are intentionally
not tracked by Git.

- Authoritative project: <https://github.com/gaia-solutions-on-demand/DFireDataset>
- Reproducible download: the ready-to-use Kaggle mirror linked by that project
- Kaggle reference: `sayedgamal99/smoke-fire-detection-yolo`
- Mirror version observed: `2025-01-27T12:37:37.047Z`
- Reported archive size: `3,118,334,483` bytes
- Dataset license: CC0 1.0 Universal
- Classes in BBIYONG output: `0: fire`, `1: smoke`

Run `scripts/download_dfire.py`, then `scripts/prepare_dataset.py` as documented
in the parent README. The download script writes a local manifest containing the
actual archive size and SHA-256 digest.

When publishing results, cite:

> Pedro Vinicius Almeida Borges de Venancio, Adriano Chaves Lisboa, and Adriano
> Vilela Barbosa. An automatic fire detection system based on deep convolutional
> neural networks for low-power, resource-constrained devices. Neural Computing
> and Applications, 2022.

