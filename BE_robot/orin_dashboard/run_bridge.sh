#!/usr/bin/env bash
set -Eeuo pipefail

# Start the camera producer (when needed) and keep cloud_bridge.py in the
# foreground so systemd/nohup can supervise the real process.
DASH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CAMERA_DIR="${ORINCAR_CAMERA_DIR:-$HOME/trt}"
CAMERA_SCRIPT="${ORINCAR_CAMERA_SCRIPT:-$CAMERA_DIR/camera_node.py}"
PYTHON_BIN="${ORINCAR_PYTHON:-python3}"

# Deployment-only secrets and URLs may live here; neither file is committed.
for env_file in "$HOME/.config/bbiyong/cloud-bridge.env" "$DASH_DIR/.env"; do
    if [[ -r "$env_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$env_file"
        set +a
    fi
done

export ORINCAR_CAMERA_MODE="${ORINCAR_CAMERA_MODE:-h264}"
export ORINCAR_VIDEO_TRANSPORT="${ORINCAR_VIDEO_TRANSPORT:-h264}"
export ORINCAR_H264_FRAME_FILE="${ORINCAR_H264_FRAME_FILE:-/dev/shm/orincar_h264.bin}"
export ORINCAR_H264_VIDEO_HZ="${ORINCAR_H264_VIDEO_HZ:-15}"
export ORINCAR_H264_BITRATE_KBPS="${ORINCAR_H264_BITRATE_KBPS:-1200}"
export ORINCAR_H264_KEY_INTERVAL="${ORINCAR_H264_KEY_INTERVAL:-30}"

if [[ -z "${ORINCAR_ROBOT_TOKEN:-${BBIYONG_ROBOT_UPLOAD_TOKEN:-}}" ]]; then
    echo "warning: no robot token configured; a protected /ws/robot will return HTTP 401" >&2
    echo "set BBIYONG_ROBOT_UPLOAD_TOKEN in ~/.config/bbiyong/cloud-bridge.env" >&2
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "error: Python executable not found: $PYTHON_BIN" >&2
    exit 1
fi
if [[ ! -r "$DASH_DIR/cloud_bridge.py" ]]; then
    echo "error: missing $DASH_DIR/cloud_bridge.py" >&2
    exit 1
fi
if [[ "$ORINCAR_VIDEO_TRANSPORT" == "h264" && ! -r "$DASH_DIR/h264_protocol.py" ]]; then
    echo "error: H.264 mode requires $DASH_DIR/h264_protocol.py" >&2
    echo "deploy MR !264 before starting H.264 transport" >&2
    exit 1
fi

if [[ -r /opt/ros/humble/setup.bash ]]; then
    set +u
    # shellcheck disable=SC1091
    source /opt/ros/humble/setup.bash
    set -u
fi
if [[ -r "$HOME/ydlidar_ros2_ws/install/setup.bash" ]]; then
    set +u
    # shellcheck disable=SC1091
    source "$HOME/ydlidar_ros2_ws/install/setup.bash"
    set -u
fi

camera_running() {
    pgrep -f '[p]ython3 .*camera_node\.py' >/dev/null 2>&1
}

if [[ "${ORINCAR_RESTART_CAMERA:-0}" == "1" ]] && camera_running; then
    echo "[camera] stopping existing camera_node.py"
    pkill -TERM -f '[p]ython3 .*camera_node\.py' || true
    for _ in {1..20}; do
        camera_running || break
        sleep 0.25
    done
fi

if [[ "${ORINCAR_START_CAMERA:-1}" == "1" ]] && ! camera_running; then
    if [[ ! -r "$CAMERA_SCRIPT" ]]; then
        echo "error: camera script not found: $CAMERA_SCRIPT" >&2
        echo "set ORINCAR_CAMERA_SCRIPT to its deployed path" >&2
        exit 1
    fi
    echo "[camera] starting $ORINCAR_CAMERA_MODE mode from $CAMERA_SCRIPT"
    (
        cd "$CAMERA_DIR"
        setsid nohup "$PYTHON_BIN" -u "$CAMERA_SCRIPT" \
            </dev/null >/tmp/camera.log 2>&1 &
    )
fi

if [[ "$ORINCAR_VIDEO_TRANSPORT" == "h264" ]]; then
    for _ in {1..30}; do
        [[ -s "$ORINCAR_H264_FRAME_FILE" ]] && break
        sleep 0.5
    done
    if [[ ! -s "$ORINCAR_H264_FRAME_FILE" ]]; then
        echo "warning: no H.264 frame after 15 seconds; bridge will use JPEG fallback" >&2
        echo "check /tmp/camera.log; restart with ORINCAR_RESTART_CAMERA=1 if an old legacy camera is running" >&2
    fi
fi

echo "[bridge] transport=$ORINCAR_VIDEO_TRANSPORT robot=${ORINCAR_ROBOT_ID:-orinka_01}"
cd "$DASH_DIR"
exec "$PYTHON_BIN" -u cloud_bridge.py "$@"
