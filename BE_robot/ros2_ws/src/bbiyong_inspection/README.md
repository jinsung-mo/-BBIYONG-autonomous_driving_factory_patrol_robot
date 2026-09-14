# bbiyong_inspection

An isolated ROS 2 package for AprilTag-triggered wall pings and sequential
Nav2 inspection patrol. It does not alter or start the existing camera, SLAM,
localization, Nav2, safety, or command-mux stacks.

## Safety behavior

- No node in this package publishes `geometry_msgs/Twist`.
- `inspection_patrol` starts inert with ESTOP assumed engaged.
- Motion requires a valid route, an explicit `START` command,
  `/bbiyong/control_mode == "autonomy"`, `/bbiyong/estop == false`, and an
  available `/navigate_to_pose` action server.
- Route replacement, manual/disabled mode, ESTOP, pause, and stop request
  cancellation of an accepted Nav2 goal.
- Candidate points require explicit confirmation by default.
- Map identity must match across projection, storage, and patrol.

## Nodes

### `apriltag_detector`

Polls the existing atomic `/tmp/orincar_cam.json` dashboard JPEG at 2 Hz. It
never opens `/dev/video0`, subscribes to a camera topic, or modifies the 30 FPS
H.264 pipeline. It publishes stable detections as versioned JSON on
`/apriltag/detections`. Stale/malformed previews and missing OpenCV `aruco`
support leave the node non-actuating and `DEGRADED` on `/apriltag/status`.

The current ray uses the same estimated 48-degree horizontal FOV as
`camera_node.py`. Calibrate `camera_hfov_deg` before relying on wall-hit
accuracy; AprilTag candidates still require explicit confirmation by default.

### `wall_ping_projector`

Transforms each calibrated camera ray into `map`, traverses `/map` to the first
occupied cell, and searches free space for a stand-off viewpoint facing that
cell. It publishes candidates on `/inspection/candidates`.

Manual target input uses `/inspection/manual_target`:

```json
{"schemaVersion":1,"kind":"manual_target","requestId":"ui-42","x":4.8,"y":1.3}
```

The coordinate must be close to an occupied cell. The active `map -> base_link`
transform determines which side of the wall receives the viewpoint.

### `inspection_point_manager`

Maintains pending candidates and atomically persists confirmed points. Its
default file is `~/.local/state/bbiyong/inspection_points.json`.

Confirm a candidate:

```json
{"schemaVersion":1,"kind":"inspection_point_command","command":"CONFIRM","candidateId":"tag-active-map-17","name":"Panel A"}
```

Other commands are `REJECT`, `UPDATE`, `DELETE`, and `PUBLISH`. Confirmed
points are published with transient-local QoS on `/inspection/points`.

### `inspection_patrol`

Submits one `NavigateToPose` goal per confirmed viewpoint. The viewpoint yaw
faces the wall target. After arrival it publishes `/inspection/check_request`.
Until the later camera-inspector node exists, the default configuration waits
two seconds and advances.

Start only after Nav2 and autonomy have been deliberately enabled:

```json
{"schemaVersion":1,"kind":"inspection_patrol_command","command":"START"}
```

`PAUSE` cancels and retains the current index. `STOP` cancels and resets it.

## Build

From the ROS workspace root:

```bash
colcon build --packages-select bbiyong_inspection
source install/setup.bash
```

The package is not included by any existing launch file. It can be started
explicitly after `camera_node.py` is writing its dashboard preview:

```bash
ros2 launch bbiyong_inspection inspection.launch.py
```

Starting it before that file exists is non-actuating: perception reports that
it is waiting, and patrol remains disarmed.

## AprilTag-only smoke test

With `camera_node.py` already running, this starts only the detector and a
passive listener. It prints `DETECTED tag=<id>` and exits successfully after a
stable tag, or prints `NOT_DETECTED` and exits with status 1 after 30 seconds:

```bash
cd ~/bbiyong_ros2_ws
colcon build --symlink-install --packages-select bbiyong_inspection
bash src/bbiyong_inspection/scripts/test_apriltag_detector.sh 30
```
