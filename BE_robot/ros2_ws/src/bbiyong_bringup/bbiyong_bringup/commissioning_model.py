"""Pure commissioning rules shared by the ROS probe and unit tests."""

RUNTIME_NODES = (
    "bbiyong_cmd_mux",
    "bbiyong_control_state_bridge",
    "bbiyong_manual_drive_bridge",
    "controller_server",
    "smoother_server",
    "planner_server",
    "behavior_server",
    "bt_navigator",
    "waypoint_follower",
    "velocity_smoother",
    "collision_slowdown_monitor",
    "collision_monitor",
)

RUNTIME_LIFECYCLE_NODES = (
    "controller_server",
    "smoother_server",
    "planner_server",
    "behavior_server",
    "bt_navigator",
    "waypoint_follower",
    "velocity_smoother",
    "collision_slowdown_monitor",
    "collision_monitor",
)

REQUIRED_ACTIONS = ("/navigate_to_pose", "/follow_waypoints")


def _base_name(value):
    return str(value or "").rstrip("/").rsplit("/", 1)[-1]


def _check(name, ok, detail):
    return {"name": name, "ok": bool(ok), "detail": str(detail)}


def evaluate_snapshot(mode, snapshot):
    """Return stable, serializable checks for a mapping or scouting snapshot."""
    if mode not in {"mapping", "scouting"}:
        raise ValueError("mode must be mapping or scouting")

    nodes = [_base_name(item) for item in snapshot.get("nodes", [])]
    map_publishers = [
        _base_name(item) for item in snapshot.get("map_publishers", [])
    ]
    cmd_vel_publishers = [
        _base_name(item) for item in snapshot.get("cmd_vel_publishers", [])
    ]
    lifecycle = snapshot.get("lifecycle", {})
    actions = set(snapshot.get("actions", []))
    authorities = set(snapshot.get("map_odom_authorities", []))
    checks = []

    for node in RUNTIME_NODES:
        count = nodes.count(node)
        checks.append(_check(
            f"runtime node {node}", count == 1, f"count={count}"
        ))
    checks.append(_check(
        "final /cmd_vel publisher",
        cmd_vel_publishers == ["bbiyong_cmd_mux"],
        f"publishers={cmd_vel_publishers}",
    ))
    for node in RUNTIME_LIFECYCLE_NODES:
        state = lifecycle.get(node, "unavailable")
        checks.append(_check(
            f"lifecycle {node}", state == "active", f"state={state}"
        ))
    for action in REQUIRED_ACTIONS:
        checks.append(_check(
            f"action {action}", action in actions,
            "ready" if action in actions else "unavailable",
        ))

    if mode == "mapping":
        checks.extend((
            _check(
                "mapping provider",
                nodes.count("slam_toolbox") == 1,
                f"slam_toolbox count={nodes.count('slam_toolbox')}",
            ),
            _check(
                "scouting providers absent",
                not any(name in nodes for name in (
                    "map_server", "amcl", "bbiyong_scouting_guard"
                )),
                "map_server/amcl/scouting_guard must not run during mapping",
            ),
            _check(
                "single /map owner",
                map_publishers == ["slam_toolbox"],
                f"publishers={map_publishers}",
            ),
            _check(
                "single map->odom authority",
                len(authorities) == 1,
                f"publisher_gids={sorted(authorities)}",
            ),
            _check(
                "lifecycle slam_toolbox",
                lifecycle.get("slam_toolbox") == "active",
                f"state={lifecycle.get('slam_toolbox', 'unavailable')}",
            ),
        ))
    else:
        provider_counts = {
            name: nodes.count(name)
            for name in ("map_server", "amcl", "bbiyong_scouting_guard")
        }
        checks.extend((
            _check(
                "slam provider absent",
                nodes.count("slam_toolbox") == 0,
                f"slam_toolbox count={nodes.count('slam_toolbox')}",
            ),
            _check(
                "scouting providers",
                all(count == 1 for count in provider_counts.values()),
                f"counts={provider_counts}",
            ),
            _check(
                "single /map owner",
                map_publishers == ["map_server"],
                f"publishers={map_publishers}",
            ),
            _check(
                "single map->odom authority",
                len(authorities) == 1,
                f"publisher_gids={sorted(authorities)}",
            ),
            _check(
                "finite AMCL pose",
                snapshot.get("localization_pose_valid") is True,
                f"valid={snapshot.get('localization_pose_valid', False)}",
            ),
            _check(
                "fresh scouting session",
                snapshot.get("scouting_session_ready") is True,
                f"ready={snapshot.get('scouting_session_ready', False)}",
            ),
        ))
        for node in ("map_server", "amcl"):
            state = lifecycle.get(node, "unavailable")
            checks.append(_check(
                f"lifecycle {node}", state == "active", f"state={state}"
            ))

    return {
        "schemaVersion": 1,
        "mode": mode,
        "ok": all(item["ok"] for item in checks),
        "checks": checks,
    }
