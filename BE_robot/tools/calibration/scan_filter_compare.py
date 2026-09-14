#!/usr/bin/env python3
"""Compare timestamp-matched /scan_raw and /scan_filtered messages."""

import argparse
from collections import defaultdict
import math

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan


def stamp_ns(scan: LaserScan) -> int:
    return scan.header.stamp.sec * 1_000_000_000 + scan.header.stamp.nanosec


def is_valid(scan: LaserScan, value: float) -> bool:
    return math.isfinite(value) and scan.range_min <= value <= scan.range_max


class ScanFilterComparison(Node):
    def __init__(self, pairs: int) -> None:
        super().__init__("scan_filter_compare")
        self.target_pairs = pairs
        self.raw_by_stamp: dict[int, LaserScan] = {}
        self.done = False
        self.pairs = 0
        self.raw_valid = 0
        self.filtered_valid = 0
        self.removed_by_sector: dict[int, int] = defaultdict(int)
        self.raw_by_sector: dict[int, int] = defaultdict(int)
        self.create_subscription(
            LaserScan, "/scan_raw", self.on_raw, qos_profile_sensor_data
        )
        self.create_subscription(
            LaserScan, "/scan_filtered", self.on_filtered, qos_profile_sensor_data
        )

    def on_raw(self, scan: LaserScan) -> None:
        self.raw_by_stamp[stamp_ns(scan)] = scan
        if len(self.raw_by_stamp) > 50:
            del self.raw_by_stamp[min(self.raw_by_stamp)]

    def on_filtered(self, filtered: LaserScan) -> None:
        raw = self.raw_by_stamp.pop(stamp_ns(filtered), None)
        if raw is None or len(raw.ranges) != len(filtered.ranges):
            return
        self.pairs += 1
        for index, (raw_range, filtered_range) in enumerate(
            zip(raw.ranges, filtered.ranges)
        ):
            raw_is_valid = is_valid(raw, raw_range)
            filtered_is_valid = is_valid(filtered, filtered_range)
            self.raw_valid += int(raw_is_valid)
            self.filtered_valid += int(filtered_is_valid)
            if not raw_is_valid:
                continue
            angle_deg = math.degrees(raw.angle_min + index * raw.angle_increment)
            sector = int(math.floor(angle_deg / 15.0) * 15)
            self.raw_by_sector[sector] += 1
            self.removed_by_sector[sector] += int(not filtered_is_valid)
        if self.pairs >= self.target_pairs:
            self.report()
            self.done = True

    def report(self) -> None:
        removed = self.raw_valid - self.filtered_valid
        ratio = 100.0 * removed / self.raw_valid if self.raw_valid else 0.0
        print(
            f"matched_scans={self.pairs} raw_valid={self.raw_valid} "
            f"filtered_valid={self.filtered_valid} removed={removed} ({ratio:.2f}%)"
        )
        print("removed valid returns by 15-degree sector:")
        for sector in sorted(self.raw_by_sector):
            count = self.removed_by_sector[sector]
            if count:
                total = self.raw_by_sector[sector]
                print(
                    f"  {sector:+04d}..{sector + 15:+04d} deg: "
                    f"{count}/{total} ({100.0 * count / total:.1f}%)"
                )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=100)
    args = parser.parse_args()
    rclpy.init()
    node = ScanFilterComparison(max(1, args.pairs))
    try:
        while rclpy.ok() and not node.done:
            rclpy.spin_once(node, timeout_sec=0.5)
    except KeyboardInterrupt:
        node.report()
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
