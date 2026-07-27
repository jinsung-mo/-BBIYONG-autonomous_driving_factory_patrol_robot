#!/usr/bin/env python3
"""Bridge ROS navigation data to small, atomic dashboard JSON files.

The live file contains only pose/scan and is refreshed at the configured rate.
Map files are rewritten only when classified occupancy data actually changes.
"""
import argparse
import json
import math
import os
import time

import numpy as np
import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.node import Node
from rclpy.qos import (
    DurabilityPolicy,
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
    qos_profile_sensor_data,
)
from sensor_msgs.msg import LaserScan
from tf2_ros import Buffer, TransformListener

from nav_protocol import (
    SCHEMA_VERSION,
    classify_cells,
    encode_patch,
    encode_runs,
)

SCAN_STRIDE = 4


def atomic_json(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as file:
        json.dump(payload, file, separators=(",", ":"))
    os.replace(tmp, path)


class NavBridge(Node):
    def __init__(self, live_path, map_path, update_path, hz):
        super().__init__("nav_bridge")
        self.live_path = live_path
        self.map_path = map_path
        self.update_path = update_path
        self.map_sequence = 0
        self.map_cells = None
        self.map_geometry = None
        self.scan_msg = None

        self.create_subscription(
            OccupancyGrid,
            "/map",
            self._map,
            QoSProfile(
                reliability=ReliabilityPolicy.RELIABLE,
                durability=DurabilityPolicy.TRANSIENT_LOCAL,
                history=HistoryPolicy.KEEP_LAST,
                depth=1,
            ),
        )
        self.create_subscription(
            LaserScan, "/scan", self._scan, qos_profile_sensor_data
        )
        self.tf_buf = Buffer()
        self.tf_listener = TransformListener(self.tf_buf, self)
        self.create_timer(1.0 / hz, self.dump_live)

    def _map(self, message):
        geometry = {
            "w": int(message.info.width),
            "h": int(message.info.height),
            "res": float(message.info.resolution),
            "ox": float(message.info.origin.position.x),
            "oy": float(message.info.origin.position.y),
        }
        cells = classify_cells(message.data)
        if geometry == self.map_geometry and cells == self.map_cells:
            return

        previous = self.map_cells
        previous_sequence = self.map_sequence
        self.map_sequence += 1
        snapshot = {
            "schema_version": SCHEMA_VERSION,
            "kind": "snapshot",
            "sequence": self.map_sequence,
            **geometry,
            "encoding": "rle-v1",
            "cells": encode_runs(cells),
        }
        update = snapshot
        if previous is not None and geometry == self.map_geometry:
            patch = encode_patch(previous, cells)
            candidate = {
                "schema_version": SCHEMA_VERSION,
                "kind": "patch",
                "base_sequence": previous_sequence,
                "sequence": self.map_sequence,
                "encoding": "runs-v1",
                "changes": patch,
            }
            if len(json.dumps(candidate)) < len(json.dumps(snapshot)):
                update = candidate

        try:
            atomic_json(self.map_path, snapshot)
            atomic_json(self.update_path, update)
            self.map_geometry = geometry
            self.map_cells = cells
        except OSError as exc:
            self.get_logger().warning(f"map write failed: {exc}")

    def _scan(self, message):
        self.scan_msg = message

    def pose(self):
        for parent in ("map", "odom"):
            try:
                transform = self.tf_buf.lookup_transform(
                    parent, "base_link", rclpy.time.Time()
                )
            except Exception:
                continue
            rotation = transform.transform.rotation
            return {
                "frame": parent,
                "x": transform.transform.translation.x,
                "y": transform.transform.translation.y,
                "yaw": math.atan2(
                    2 * (rotation.w * rotation.z),
                    1 - 2 * (rotation.z * rotation.z),
                ),
            }
        return None

    def dump_live(self):
        payload = {
            "schema_version": SCHEMA_VERSION,
            "t": time.time(),
            "map_sequence": self.map_sequence,
            "pose": self.pose(),
            "scan": None,
        }
        if self.scan_msg is not None:
            scan = self.scan_msg
            ranges = np.asarray(scan.ranges, dtype=float)[::SCAN_STRIDE]
            ranges = np.where(
                np.isfinite(ranges)
                & (ranges > scan.range_min)
                & (ranges < scan.range_max),
                ranges,
                0.0,
            )
            payload["scan"] = {
                "angle_min": float(scan.angle_min),
                "angle_inc": float(scan.angle_increment * SCAN_STRIDE),
                "ranges": [round(float(value), 3) for value in ranges],
            }
        try:
            atomic_json(self.live_path, payload)
        except OSError as exc:
            self.get_logger().warning(f"live write failed: {exc}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", default="/tmp/orincar_nav_live.json")
    parser.add_argument("--map", dest="map_path", default="/tmp/orincar_nav_map.json")
    parser.add_argument(
        "--update", default="/tmp/orincar_nav_map_update.json"
    )
    parser.add_argument("--hz", type=float, default=2.0)
    args = parser.parse_args()

    rclpy.init()
    node = NavBridge(args.live, args.map_path, args.update, args.hz)
    node.get_logger().info(
        f"nav bridge: live={args.live}, map={args.map_path} @ {args.hz}Hz"
    )
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == "__main__":
    main()
