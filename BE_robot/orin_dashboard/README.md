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
- `MAP` (2D occupancy grid) from `nav_map.json`, sent only when its `sequence`
  changes. The server relays the raw payload to `/topic/nav/{robot_id}`; the
  dashboard decodes the RLE and renders it. Disable with `--map-hz 0`.

Inbound (server → robot, `ControlCommand`):

- `DRIVE {linear, angular}` and `ESTOP {active}` are written to
  `/tmp/orincar_drive.json`; `teleop_node.py` consumes it and re-clamps limits.
- `SET_MODE`, `NAVIGATE`, `SAVE_MAP` need ROS process/action orchestration and are
  logged but not yet acted on (stage 2).

Pure mapping logic is unit-tested in `tests/test_cloud_bridge.py` (no pip deps).
`tests/smoke_cloud_bridge.py` exercises the full asyncio/websockets path and the
DRIVE round-trip (requires `websockets`).
