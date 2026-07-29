#!/usr/bin/env bash
# OrinCar 전체 스택 기동. 인자 없으면 전부, 있으면 지정한 것만.
#
#   ~/calib/stack_up.sh              # 전부 (지도 새로 시작)
#   ~/calib/stack_up.sh keepmap      # SLAM 은 건드리지 않고 나머지만
#
# 스크립트로 만든 이유: `ssh orin 'pkill -f async_slam_toolbox'` 처럼 쓰면
# **그 ssh 명령 자신의 명령줄에 패턴이 있어** pkill 이 자기를 죽인다.
# 오늘만 다섯 번 당했다. 실행 명령줄이 경로뿐인 스크립트 안에서는 안전하다.
KEEPMAP="${1:-}"

source /opt/ros/humble/setup.bash
source "$HOME/ydlidar_ros2_ws/install/setup.bash"

stop() { pkill -f "$1" 2>/dev/null; }
up() {   # up <이름> <명령...>
    local name="$1"; shift
    setsid nohup "$@" < /dev/null > "/tmp/${name}.log" 2>&1 &
    disown
}

stop 'ydlidar_ros2_driver_node'
stop 'scan_to_scan_filter_chain'
stop 'topic_tools.*relay.*/scan_filtered.*/scan'
stop 'esp32_base_node'
stop 'camera_node.py'
stop 'teleop_node.py'
[ "$KEEPMAP" != "keepmap" ] && stop 'async_slam_toolbox_node'
sleep 3

# Use the versioned project configuration deployed to ~/calib. The vendor
# install YAML previously restored clockwise (mirrored) LaserScan angles on
# every restart.
PARAMS="$HOME/calib/ydlidar.yaml"
up ydlidar ros2 run ydlidar_ros2_driver ydlidar_ros2_driver_node \
    --ros-args --params-file "$PARAMS" -r scan:=/scan_raw
sleep 10
up scan_filter ros2 run laser_filters scan_to_scan_filter_chain \
    --ros-args --params-file "$HOME/calib/scan_filter.yaml" \
    -r scan:=/scan_raw -r scan_filtered:=/scan_filtered
up scan_relay ros2 run topic_tools relay /scan_filtered /scan
sleep 3
up base python3 "$HOME/calib/esp32_base_node.py"
sleep 7
if [ "$KEEPMAP" != "keepmap" ]; then
    up slam ros2 run slam_toolbox async_slam_toolbox_node \
        --ros-args --params-file "$HOME/calib/slam_params.yaml"
    sleep 10
fi
( cd "$HOME/trt" && up camera python3 camera_node.py )
sleep 6

echo "── 상태 ──"
for t in /scan_raw /scan_filtered /scan /odom /map /camera/floor_clear; do
    if ros2 topic list 2>/dev/null | grep -qx "$t"; then echo "  ✓ $t"
    else echo "  ✗ $t"; fi
done
grep -h "정적 TF" /tmp/base.log 2>/dev/null | tail -1
grep -h "엔진 로드" /tmp/camera.log 2>/dev/null | tail -1
