#!/usr/bin/env bash
set -Eeo pipefail

# Starts only bbiyong_apriltag_detector plus a passive result listener.
# Exit 0: DETECTED. Exit 1: no stable tag before timeout.
TIMEOUT_SECONDS="${1:-30}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
PARAMS_FILE="${BBIYONG_APRILTAG_PARAMS:-$WORKSPACE/src/bbiyong_inspection/config/inspection.yaml}"

source /opt/ros/humble/setup.bash
if [[ -r "$HOME/ydlidar_ros2_ws/install/setup.bash" ]]; then
    source "$HOME/ydlidar_ros2_ws/install/setup.bash"
fi
if [[ ! -r "$WORKSPACE/install/setup.bash" ]]; then
    echo "ERROR: package is not built; run: cd $WORKSPACE && colcon build --symlink-install --packages-select bbiyong_inspection" >&2
    exit 2
fi
source "$WORKSPACE/install/setup.bash"
set -u

if [[ ! -r /tmp/orincar_cam.json ]]; then
    echo "ERROR: /tmp/orincar_cam.json is missing; camera_node.py must already be running" >&2
    exit 2
fi

exec ros2 run bbiyong_inspection apriltag_smoke_test \
    --timeout "$TIMEOUT_SECONDS" \
    --ros-args --params-file "$PARAMS_FILE"
