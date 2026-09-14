"""Read-only ROS graph and authority probe for supervised commissioning."""

import argparse
import json
import math
from pathlib import Path
import sys
import time

import rclpy
from geometry_msgs.msg import PoseWithCovarianceStamped
from lifecycle_msgs.srv import GetState
from nav2_msgs.action import FollowWaypoints, NavigateToPose
from rclpy.action import ActionClient
from rclpy.node import Node
from tf2_msgs.msg import TFMessage

from .commissioning_model import RUNTIME_LIFECYCLE_NODES, evaluate_snapshot
from .scouting_session import read_ready_session


def _full_name(name, namespace):
    namespace = str(namespace or "/").rstrip("/")
    return f"{namespace}/{name}" if namespace else f"/{name}"


def _gid(info):
    value = getattr(info, "publisher_gid", ())
    try:
        return bytes(value).hex()
    except (TypeError, ValueError):
        return repr(value)


class CommissionProbe(Node):
    def __init__(self, mode, scouting_state_file):
        super().__init__(
            "bbiyong_commission_check",
            enable_rosout=False,
            start_parameter_services=False,
        )
        self.mode = mode
        self.scouting_state_file = scouting_state_file
        self.map_odom_authorities = set()
        self.localization_pose_valid = False
        self.create_subscription(TFMessage, "/tf", self._on_tf, 50)
        if mode == "scouting":
            self.create_subscription(
                PoseWithCovarianceStamped, "/amcl_pose", self._on_pose, 10
            )
        self.actions = {
            "/navigate_to_pose": ActionClient(
                self, NavigateToPose, "/navigate_to_pose"
            ),
            "/follow_waypoints": ActionClient(
                self, FollowWaypoints, "/follow_waypoints"
            ),
        }

    def _on_tf(self, message, info):
        if any(
            transform.header.frame_id.lstrip("/") == "map"
            and transform.child_frame_id.lstrip("/") == "odom"
            for transform in message.transforms
        ):
            self.map_odom_authorities.add(_gid(info))

    def _on_pose(self, message):
        pose = message.pose.pose
        values = (
            pose.position.x, pose.position.y, pose.position.z,
            pose.orientation.x, pose.orientation.y,
            pose.orientation.z, pose.orientation.w,
        )
        norm = sum(value * value for value in values[3:])
        self.localization_pose_valid = (
            all(math.isfinite(value) for value in values) and norm > 1e-9
        )

    def _lifecycle_states(self, names, timeout):
        requests = {}
        for name in names:
            client = self.create_client(GetState, f"/{name}/get_state")
            if client.wait_for_service(timeout_sec=min(0.2, timeout)):
                requests[name] = (client, client.call_async(GetState.Request()))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and any(
            not future.done() for _, future in requests.values()
        ):
            rclpy.spin_once(self, timeout_sec=0.05)
        result = {}
        for name in names:
            pair = requests.get(name)
            if pair is None or not pair[1].done():
                result[name] = "unavailable"
                continue
            try:
                result[name] = pair[1].result().current_state.label.lower()
            except Exception:
                result[name] = "unavailable"
        return result

    def snapshot(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.05)
        nodes = [
            _full_name(name, namespace)
            for name, namespace in self.get_node_names_and_namespaces()
            if name != self.get_name()
        ]
        lifecycle_names = list(RUNTIME_LIFECYCLE_NODES)
        lifecycle_names.extend(
            ["slam_toolbox"] if self.mode == "mapping" else ["map_server", "amcl"]
        )
        scouting_ready = False
        if self.mode == "scouting" and self.scouting_state_file:
            scouting_ready = read_ready_session(
                Path(self.scouting_state_file), max_age_sec=3.0
            ) is not None
        return {
            "nodes": nodes,
            "map_publishers": [
                item.node_name
                for item in self.get_publishers_info_by_topic("/map")
            ],
            "cmd_vel_publishers": [
                item.node_name
                for item in self.get_publishers_info_by_topic("/cmd_vel")
            ],
            "map_odom_authorities": sorted(self.map_odom_authorities),
            "localization_pose_valid": self.localization_pose_valid,
            "scouting_session_ready": scouting_ready,
            "lifecycle": self._lifecycle_states(lifecycle_names, timeout),
            "actions": [
                name for name, client in self.actions.items()
                if client.server_is_ready()
            ],
        }


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="read-only mapping/scouting commissioning checks"
    )
    parser.add_argument("mode", choices=("mapping", "scouting"))
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument(
        "--scouting-state-file",
        default="/tmp/bbiyong_scouting_session.json",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_known_args(argv)


def main(args=None):
    parsed, ros_args = parse_args(args)
    if not math.isfinite(parsed.timeout) or parsed.timeout <= 0 or parsed.timeout > 30:
        raise SystemExit("timeout must be finite and between 0 and 30 seconds")
    rclpy.init(args=ros_args)
    node = CommissionProbe(parsed.mode, parsed.scouting_state_file)
    try:
        report = evaluate_snapshot(parsed.mode, node.snapshot(parsed.timeout))
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()
    if parsed.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        for item in report["checks"]:
            print(f"[{'PASS' if item['ok'] else 'FAIL'}] {item['name']}: {item['detail']}")
        print("commission-check: " + ("PASS" if report["ok"] else "FAIL"))
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main(sys.argv[1:])
