#!/usr/bin/env bash
# 라이다 드라이버를 분리 실행한다.
# 스크립트로 뺀 이유: 명령줄에 'ydlidar'가 들어가면 pkill -f 가 자기 자신을 죽인다.
# set -u 금지 — ROS의 setup.bash가 미정의 변수를 참조해 즉시 죽는다
LOG=/tmp/ydlidar_run.log

pkill -f 'ydlidar_ros2_driver_node' 2>/dev/null
sleep 2

source /opt/ros/humble/setup.bash
source "$HOME/ydlidar_ros2_ws/install/setup.bash"

# 🔴 런치 파일(ydlidar_launch.py)을 쓰지 않는다.
#    그 안에 static_transform_publisher base_link→laser_frame (0,0,0.02) 가
#    들어 있는데, 이는 벤더 예제의 자리표시자다. 우리 실측 오프셋
#    (x=+59.7mm, y=-5.1mm)을 덮어써서 SLAM이 제자리 회전을 못 맞추게 만든다.
#    TF는 esp32_base_node 가 소유하므로 여기서는 드라이버 노드만 띄운다.
PARAMS="$HOME/ydlidar_ros2_ws/install/ydlidar_ros2_driver/share/ydlidar_ros2_driver/params/ydlidar.yaml"
setsid nohup ros2 run ydlidar_ros2_driver ydlidar_ros2_driver_node \
    --ros-args --params-file "$PARAMS" \
    < /dev/null > "$LOG" 2>&1 &
disown

sleep "${1:-15}"

if ros2 topic list 2>/dev/null | grep -q '^/scan$'; then
    echo "SCAN_OK"
else
    echo "SCAN_FAIL"
    grep -iE 'timeout|device failed|error' "$LOG" | tail -4
fi
