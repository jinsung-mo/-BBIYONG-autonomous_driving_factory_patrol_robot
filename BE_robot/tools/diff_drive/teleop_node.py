#!/usr/bin/env python3
"""Retired compatibility entry point for the former direct /cmd_vel bridge."""

import sys


MESSAGE = """\
teleop_node.py has been retired because it bypassed bbiyong_cmd_mux.

Start the persistent BBIYONG navigation runtime instead. Manual commands now use:
  drive.json -> bbiyong_manual_drive_bridge -> /cmd_vel/manual
             -> bbiyong_cmd_mux -> /cmd_vel

Do not restore a direct /cmd_vel publisher. See ros2_ws/docs/PHASE7_COMMISSIONING.md.
"""


def main() -> int:
    print(MESSAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
