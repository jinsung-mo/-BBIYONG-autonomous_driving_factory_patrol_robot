# Orin dashboard

Source for the dashboard served at `https://i15e101.p.ssafy.io/robot/`.

## Navigation data contract

All navigation payloads contain `schema_version: "1.0"`.

- `GET /api/nav/live`: high-rate pose, scan, timestamp, and `map_sequence`.
- `GET /api/nav/map?since=N`: returns `304`, a current RLE snapshot, or a patch
  from sequence `N`.
- `GET /api/nav`: compatibility endpoint for older clients. It reconstructs the
  old map string on demand and is not used by the bundled dashboard.

Snapshot cells use flat RLE pairs `[value, count, ...]`. Patch changes use flat
triples `[start, count, value, ...]`. Values are `-1` unknown, `0` free, and
`100` occupied. Map sequence advances only when geometry or classified cell
content changes.

The live endpoint is deliberately separate from map transfer: adding dashboard
clients no longer multiplies full-grid serialization and bandwidth at 2 Hz.

## Cloud bridge (`cloud_bridge.py`)

Connects the robot to the control backend WebSocket endpoint `/ws/robot`. It is a
standalone process that consumes the same `/tmp/*.json` files the dashboard uses,
so ROS, `server.py`, and the bridge can each restart independently.

```
pip install websockets
python3 cloud_bridge.py --server-url wss://i15e101.p.ssafy.io/ws/robot --robot-id orinka_01
```

Outbound (robot → server, `RobotPacket`):

- `REGISTER` on connect, then `TELEMETRY` (pose/speed/inference fps/e-stop/latency)
  and `VIDEO_FRAME` (FRONT/RGB jpeg) on separate rate loops.
- `EVENT_FIRE` when `cam.json` detections confirm fire under an N-of-M rule.

Inbound (server → robot, `ControlCommand`):

- `DRIVE {linear, angular}` and `ESTOP {active}` are written to
  `/tmp/orincar_drive.json`; `teleop_node.py` consumes it and re-clamps limits.
- `SET_MODE` and `NAVIGATE` are logged but not yet acted on.
- `START_MAPPING`, `STOP_MAPPING`, and `SAVE_MAP` are handled by the opt-in
  mapping orchestrator. It saves and validates PGM/YAML, uploads the original
  PGM bytes, and queues `EVENT_MAPPING_COMPLETE` only after HTTP 201. Backend
  support for decoding RAW PGM before `FloorPlanRenderer` is a deployment
  prerequisite owned by the backend team.

Mapping stays disabled unless `--mapping-enabled` is passed (or
`ORINCAR_MAPPING_ENABLED=1` is set). The bridge also requires
`BBIYONG_ROBOT_UPLOAD_TOKEN` in its process environment; never put that token in
this repository or in `run_bridge.sh`.

The default mapping commands assume the base sensor/SLAM stack is already
running and launch only the existing exploration stack:

```text
ros2 launch bbiyong_bringup exploration.launch.py map_output:=<temporary-base>
ros2 run bbiyong_bringup save_map <temporary-base> --overwrite
```

Use `ORINCAR_MAPPING_LAUNCH_COMMAND` and `ORINCAR_MAPPING_SAVE_COMMAND` only when
the deployed workspace needs different commands. Both accept a `{map_output}`
placeholder. The orchestrator terminates only child processes it created.

Bridge and mapping logic are unit-tested in `tests/test_cloud_bridge.py` and
`tests/test_mapping_orchestrator.py` (no additional pip dependencies).
`tests/smoke_cloud_bridge.py` exercises the full asyncio/websockets path and the
DRIVE round-trip (requires `websockets`).
