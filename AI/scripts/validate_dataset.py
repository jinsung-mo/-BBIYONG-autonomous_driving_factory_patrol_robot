from __future__ import annotations

import argparse
from pathlib import Path

from dataset_utils import print_report, validate_dataset


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a YOLO object-detection dataset")
    parser.add_argument("data", type=Path, help="Path to data.yaml")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.data.is_file():
        print(f"ERROR: dataset YAML does not exist: {args.data}")
        return 2
    report = validate_dataset(args.data)
    print_report(report)
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

