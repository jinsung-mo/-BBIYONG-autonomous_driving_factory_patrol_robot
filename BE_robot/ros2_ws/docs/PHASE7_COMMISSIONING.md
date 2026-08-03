# Phase 7 deployment and supervised hardware commissioning

Phase 7 is split into two parts while the robot is being rebuilt:

- **7A (implemented):** capability gates, read-only commissioning checks,
  redacted evidence capture, and recoverable release/rollback tooling.
- **7B (pending hardware):** attended motion and obstacle validation on the
  rebuilt robot.

No movement test may be run unattended over SSH. One operator must remain next
to the robot with a physical or independently implemented software stop. The
operator running the commands and the safety observer should be different
people whenever possible.

## Capability gates

All gates default to disabled. `ESTOP` is always accepted and latched regardless
of these values. A reconnect or cloud-bridge restart always starts in
`disabled` with ESTOP engaged.

| Environment variable | Commands enabled |
|---|---|
| `ORINCAR_BACKEND_CONTROL_ENABLED=1` | `DRIVE`, `SET_MODE manual` |
| `ORINCAR_ONE_OFF_NAVIGATION_ENABLED=1` | `NAVIGATE` |
| `ORINCAR_PATROL_ENABLED=1` | `SET_PATROL_ROUTE`, `SET_MODE autonomy` |
| `ORINCAR_PATROL_LOOP_ENABLED=1` | Repeat a completed patrol route |

`ORINCAR_NAVIGATION_ENABLED=1` remains a compatibility master switch. When a
specific capability variable is present, its explicit value wins over the
master environment default. The CLI `--navigation-enabled` flag deliberately
enables every capability for legacy operator scripts.

`SET_MODE disabled` is a stop-only command and is accepted even when all
capability gates are off.

Recommended rollout values:

| Stage | Control | One-off | Patrol | Loop |
|---|---:|---:|---:|---:|
| Base/runtime, backend movement disabled | 0 | 0 | 0 | 0 |
| Manual bridge and backend mode handoff | 1 | 0 | 0 | 0 |
| One-off `NAVIGATE` | 1 | 1 | 0 | 0 |
| Single-pass route | 1 | 1 | 1 | 0 |
| Cyclic patrol | 1 | 1 | 1 | 1 |

Do not enable the next row until evidence for the current row is reviewed.

## Immutable release and rollback

Run the release manager locally on the robot. It never removes a release. It
copies only the dashboard and ROS workspace source allowlist, excludes caches
and credential-like files, writes SHA-256 hashes, and refuses to overwrite an
existing release ID.

```bash
source ~/bbiyong_ros2_ws/install/setup.bash

bbiyong release stage \
  /path/to/checkout/BE_robot \
  /home/e101/bbiyong-deploy \
  S15P11E101-624-<commit>

cd /home/e101/bbiyong-deploy/releases/S15P11E101-624-<commit>/ros2_ws
rosdep install --from-paths src --ignore-src -r -y \
  --skip-keys "ydlidar_ros2_driver rf2o_laser_odometry"
colcon build --symlink-install

bbiyong release verify \
  /home/e101/bbiyong-deploy/releases/S15P11E101-624-<commit>
```

Build output (`build`, `install`, and `log`) is deliberately outside the source
hash set. Activation changes only the atomic `current` symlink and records the
old target as `previous`. Stop the supervised robot services and engage the
independent stop before activation:

```bash
bbiyong release activate /home/e101/bbiyong-deploy \
  S15P11E101-624-<commit> \
  --confirm-stopped --confirm-independent-stop --operator "<name>"
```

If startup or a non-motion check fails, keep the stop engaged and roll back:

```bash
bbiyong release rollback /home/e101/bbiyong-deploy \
  --confirm-stopped --confirm-independent-stop --operator "<name>"
```

Service definitions should point at
`/home/e101/bbiyong-deploy/current/ros2_ws/install/setup.bash` and
`/home/e101/bbiyong-deploy/current/orin_dashboard`. Do not overwrite a dirty
checkout in place.

## Read-only commissioning and evidence

The commissioning probe subscribes to TF/localization and opens lifecycle/action
clients. It does not publish `/cmd_vel`, control mode, ESTOP, goals, routes, or
initial pose.

```bash
bbiyong commission-check mapping
bbiyong commission-check scouting
```

The check requires exactly one copy of each persistent runtime node, one final
`/cmd_vel` publisher owned by `bbiyong_cmd_mux`, active lifecycle nodes, both
Nav2 actions, exactly one map provider, and one observed `map -> odom` publisher
GID. Scouting additionally requires a finite AMCL pose and a fresh READY state
from `bbiyong_scouting_guard`.

Capture evidence before and after every stage. The output directory must not
already exist, so an earlier run cannot be overwritten. Command output and
operator-supplied logs are redacted for passwords, tokens, authorization
headers, API keys, and URL credentials, then hashed.

```bash
bbiyong collect-evidence base-runtime \
  /home/e101/commissioning/base-runtime-before

bbiyong collect-evidence saved-map-amcl \
  /home/e101/commissioning/saved-map-amcl-after \
  --mode scouting \
  --release-manifest /home/e101/bbiyong-deploy/current/release-manifest.json \
  --log /path/to/cloud-bridge.log
```

Store with each bundle: Git commit/release manifest, deployed hashes, ROS graph,
lifecycle states, process IDs, TF authority, and relevant service logs. Review
`commands.json` for failed or timed-out probes; the evidence collector records
failures instead of treating missing observations as success.

## 7B supervised sequence (after rebuild)

For every stage: begin with ESTOP engaged, confirm the configured gate values,
capture “before” evidence, run the stage, stop the robot, capture “after”
evidence, and obtain a reviewer decision before continuing.

1. **Base/runtime split:** wheels off the ground or propulsion electrically
   isolated. Start the persistent runtime twice in succession and verify a
   second owner is rejected or absent. Confirm one `/cmd_vel` publisher and
   stable PIDs across repeated mission launches.
2. **Manual bridge and mux:** use the lowest configured speeds. Check ramping,
   deadman stop, mode handoff, stale-command clearing, and ESTOP from both
   manual and autonomy states.
3. **Backend ESTOP and `SET_MODE`:** patrol and one-off gates remain disabled.
   Verify reconnect never arms or moves the robot.
4. **One-off navigation:** clear floor, short visible goal, walking-speed limit,
   and observer on the stop. Verify accept/succeed/cancel/fail reporting.
5. **Single-pass route:** two or three visible waypoints, loop disabled. Verify
   ordering, feedback, missed-point recording, cancellation, and no restart of
   runtime PIDs.
6. **Cyclic patrol:** enable the loop gate only after single-pass sign-off.
   Verify clean pause/resume and route replacement cancellation.
7. **Saved-map AMCL:** explicitly stop the mapping owner, start scouting, set an
   initial pose, run `commission-check scouting`, then reapply the route.
8. **Obstacle/recovery:** introduce large soft obstacles one at a time with an
   escape path. Verify Nav2 replanning/recovery, immediate stop, missed-point
   policy, and consecutive-failure cutoff.

The `directional_approach` polygon and `slowdown_zone` remain `enabled: false`.
Do not enable them as part of Phase 7. Nav2 obstacle layers and the independently
tuned immediate-stop circle are the initial avoidance/safety path.
