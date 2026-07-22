from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

import requests


AI_ROOT = Path(__file__).resolve().parents[1]
DATASET_REF = "sayedgamal99/smoke-fire-detection-yolo"
DATASET_VERSION = "2025-01-27T12:37:37.047Z"
DOWNLOAD_URL = f"https://www.kaggle.com/api/v1/datasets/download/{DATASET_REF}"
EXPECTED_BYTES = 3_118_334_483


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download the official D-Fire Kaggle mirror")
    parser.add_argument(
        "--output",
        type=Path,
        default=AI_ROOT / "data" / "downloads" / "dfire.zip",
        help="Destination ZIP path",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(output: Path) -> Path:
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        print(f"Using existing archive: {output}")
        return verify_and_record(output)
    partial = output.with_suffix(output.suffix + ".part")
    existing = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={existing}-"} if existing else {}

    with requests.get(DOWNLOAD_URL, headers=headers, stream=True, timeout=(30, 120)) as response:
        response.raise_for_status()
        if existing and response.status_code != 206:
            existing = 0
            partial.unlink(missing_ok=True)
        mode = "ab" if existing else "wb"
        content_length = int(response.headers.get("content-length", 0))
        total = existing + content_length if content_length else EXPECTED_BYTES
        downloaded = existing
        last_percent = -1
        with partial.open(mode) as stream:
            for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                if not chunk:
                    continue
                stream.write(chunk)
                downloaded += len(chunk)
                percent = int(downloaded * 100 / total) if total else 0
                if percent != last_percent:
                    print(f"downloaded={downloaded}/{total} ({percent}%)", flush=True)
                    last_percent = percent

    partial.replace(output)
    return verify_and_record(output)


def verify_and_record(output: Path) -> Path:
    if not zipfile.is_zipfile(output):
        raise RuntimeError(f"Downloaded file is not a valid ZIP archive: {output}")
    with zipfile.ZipFile(output) as archive:
        unpacked_bytes = sum(member.file_size for member in archive.infolist())
    if unpacked_bytes < EXPECTED_BYTES * 0.95:
        raise RuntimeError(
            f"Archive content is unexpectedly small: {unpacked_bytes} bytes; expected about {EXPECTED_BYTES}"
        )
    actual_bytes = output.stat().st_size
    digest = sha256(output)
    manifest = {
        "dataset": "D-Fire",
        "source_repository": "https://github.com/gaia-solutions-on-demand/DFireDataset",
        "kaggle_ref": DATASET_REF,
        "source_version": DATASET_VERSION,
        "download_url": DOWNLOAD_URL,
        "license": "CC0-1.0",
        "archive": output.name,
        "bytes": actual_bytes,
        "unpacked_bytes": unpacked_bytes,
        "sha256": digest,
    }
    output.with_suffix(".manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"archive={output}")
    print(f"sha256={digest}")
    return output


def main() -> int:
    args = parse_args()
    try:
        download(args.output)
        return 0
    except (OSError, requests.RequestException, RuntimeError) as exc:
        print(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
