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

- `DRIVE {linear, angular}` is written atomically to `/tmp/orincar_drive.json`.
  The persistent ROS runtime's `manual_drive_bridge` clamps, ramps, applies the
  deadman and LiDAR guard, and publishes only `/cmd_vel/manual`.
- `ESTOP {active}` updates both drive and control state. Emergency stop remains
  active even when autonomous navigation is feature-disabled.
- `SET_PATROL_ROUTE`, `SET_MODE`, and `NAVIGATE` are owned by the navigation
  orchestrator. Route/state are persisted atomically and every bridge restart
  returns the robot to `disabled` with e-stop engaged.
- `START_MAPPING`, `STOP_MAPPING`, and `SAVE_MAP` are handled by the opt-in
  mapping orchestrator. It saves and validates PGM/YAML, uploads the original
  PGM bytes, and queues `EVENT_MAPPING_COMPLETE` only after HTTP 201. Backend
  support for decoding RAW PGM before `FloorPlanRenderer` is a deployment
  prerequisite owned by the backend team.
- `EVENT_SAVED {eventId, type}` is validated and placed in a durable local
  queue. The matching finalized blackbox MP4 is uploaded asynchronously to
  `POST /api/videos/upload` with `clipType=EVENT`; a slow or offline upload does
  not block WebSocket commands or cause the backend event to be recreated.

`camera_node.py` owns both camera capture and a bounded rolling recorder so a
second process never opens `/dev/video0`. By default it finalizes a 10-second
MP4 segment and retains five minutes under
`~/.local/state/bbiyong/blackbox`. Its manifest and the bridge upload queue are
atomically persisted. Configure the shared manifest with
`ORINCAR_BLACKBOX_MANIFEST`, retention with
`ORINCAR_BLACKBOX_RETENTION_SECONDS`, and disable recording only for diagnostics
with `--no-blackbox`. Event clips are limited to 200 MiB and authenticated with
`BBIYONG_ROBOT_UPLOAD_TOKEN`. `ORINCAR_EVENT_CLIP_ENABLED=0` disables only the
upload consumer; pending jobs remain on disk for a later restart.

Mapping stays disabled unless `--mapping-enabled` is passed (or
`ORINCAR_MAPPING_ENABLED=1` is set). The bridge also requires
`BBIYONG_ROBOT_UPLOAD_TOKEN` in its process environment; never put that token in
this repository or in `run_bridge.sh`.

Backend motion stays disabled by default. Deployments should enable capabilities
in guarded stages with `ORINCAR_BACKEND_CONTROL_ENABLED`,
`ORINCAR_ONE_OFF_NAVIGATION_ENABLED`, `ORINCAR_PATROL_ENABLED`, and
`ORINCAR_PATROL_LOOP_ENABLED`. `ORINCAR_NAVIGATION_ENABLED=1` and the
`--navigation-enabled` CLI flag remain compatibility master switches. ESTOP is
always handled even when every capability is disabled. The built-in subprocess templates
run `patrol_route` and `navigate_goal`; deployments may override them with
`ORINCAR_PATROL_COMMAND` and `ORINCAR_NAVIGATE_COMMAND`. Supported placeholders
are `{route_file}` and `{patrol_loop}` for patrol and `{x}`, `{y}`, `{yaw}` for
point navigation. Custom patrol templates that omit `{patrol_loop}` remain
single-pass because the patrol node defaults to looping disabled.
Both commands still reject motion unless a fresh saved-map scouting session is
ready.

See `ros2_ws/docs/PHASE7_COMMISSIONING.md` for the staged gate matrix,
hash-verified release/rollback procedure, evidence capture, and attended
hardware validation checklist.

The patrol client is available as `ros2 run bbiyong_bringup
patrol_route --ros-args -p route_file:=<route.json>` (or `bbiyong patrol
<route.json>`). One-off goals use `navigate_goal`. Routes are bound to the
current `scoutingSessionId`; after changing maps the backend must send
`SET_PATROL_ROUTE` again before autonomy can start.

The default mapping commands assume both the base sensor/SLAM stack and
`bbiyong mapping-runtime` are already running. The orchestrator verifies
`/navigate_to_pose`, `/follow_waypoints`, and `/bbiyong_cmd_mux`, then launches
only the short-lived exploration mission:

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
