# LiDAR filtering and Nav2 sensor model

The runtime owns two scan topics:

- `/scan_raw`: unmodified YDLIDAR output for calibration and rosbag evidence.
- `/scan_filtered`: range-limited, measured-sector-masked input for SLAM,
  localization, Nav2 costmaps, and collision monitoring.
- `/scan`: compatibility relay of `/scan_filtered` for legacy calibration and
  teleoperation nodes. New consumers must use `/scan_filtered` explicitly.

Do not synthesize walls or interpolate missing returns into either the SLAM or
collision pipeline. Nav2's obstacle layer raytraces from the sensor origin to
each valid return to clear observed free space. Invalid and masked returns stay
unknown.

## Filter chain

`config/scan_filter.yaml` applies, in order:

1. Physical/practical range limits (`0.15 m` to `8.0 m`).
2. The measured unstable `-105°..-90°` sector.

The angular mask comes from the 2026-07-27 stationary scan profile. Add or
expand masks only after recording the same stationary and rotation bags at
multiple robot headings. Median and interpolation filters are intentionally
excluded. A two-neighbour speckle filter was also rejected after the live
same-stamp comparison removed 15.8% of valid returns and heavily affected
several unmasked sectors. Isolated occupancy noise is handled by Nav2's
costmap-only `DenoiseLayer` instead.

Compare the live topics with:

```bash
python3 BE_robot/tools/calibration/scan_filter_compare.py --pairs 100
```

Standard bags must contain `/scan_raw`, `/scan_filtered`, `/odom`, `/tf`,
`/tf_static`, `/map`, `/cmd_vel`, and `/diagnostics`.

## Nav2 layers

Both differential and Ackermann templates use:

1. `StaticLayer` on the global costmap only.
2. `ObstacleLayer` with `/scan_filtered` for marking and raytrace clearing.
3. `DenoiseLayer` with a minimum connected group size of two.
4. `InflationLayer` after denoising.

`collision_monitor.yaml` receives `/cmd_vel/autonomy_raw` from the velocity
smoother and publishes guarded commands to `/cmd_vel/autonomy`. It independently
applies slowdown and stop polygons from `/scan_filtered`.

The collision monitor is an additional safety layer, not a replacement for the
motor-controller watchdog or physical emergency stop.
