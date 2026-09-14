import argparse
from pathlib import Path
import subprocess


def main(args=None) -> None:
    parser = argparse.ArgumentParser(description="Save /map as PGM and YAML")
    parser.add_argument("name", help="output base path without extension")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--overwrite", action="store_true")
    parsed = parser.parse_args(args)
    base = Path(parsed.name).expanduser().resolve()
    base.parent.mkdir(parents=True, exist_ok=True)
    expected = (Path(f"{base}.pgm"), Path(f"{base}.yaml"))
    if not parsed.overwrite and any(path.exists() for path in expected):
        raise FileExistsError(f"map already exists: {base}; use --overwrite to replace it")
    command = [
        "ros2", "run", "nav2_map_server", "map_saver_cli", "-f", str(base),
        "--ros-args", "-p", f"save_map_timeout:={parsed.timeout}",
    ]
    subprocess.run(command, check=True)
    missing = [str(path) for path in expected if not path.is_file() or path.stat().st_size == 0]
    if missing:
        raise RuntimeError("map save did not create non-empty files: " + ", ".join(missing))
    print(f"saved {expected[0]} and {expected[1]}")
