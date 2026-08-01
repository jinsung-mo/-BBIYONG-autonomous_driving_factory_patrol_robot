#!/usr/bin/env bash
# esp32_base_node 를 **주행로그 켠 채로** 재기동한다. teleop 도 같이 살린다.
#
#   base_relog.sh <purpose>
#
# 스크립트로 만든 이유: `ssh orin 'pkill -f esp32_base_node'` 는 그 ssh 자신의
# 명령줄에 패턴이 있어 pkill 이 자기를 죽인다. (오늘 여러 번 당했다.)
PURPOSE="${1:-drive-diag}"
CHASSIS="orincar-1"

pkill -f 'python3 .*teleop_node\.py' 2>/dev/null
pkill -f 'python3 .*esp32_base_node\.py' 2>/dev/null
sleep 3

source /opt/ros/humble/setup.bash

setsid nohup python3 "$HOME/calib/esp32_base_node.py" \
    --ros-args \
    -p purpose:="$PURPOSE" \
    -p chassis_id:="$CHASSIS" \
    < /dev/null > /tmp/base.log 2>&1 &
disown
sleep 7

setsid nohup python3 "$HOME/calib/teleop_node.py" \
    < /dev/null > /tmp/teleop.log 2>&1 &
disown
sleep 5

echo "── 상태 ──"
pgrep -f 'esp32_base_node\.py' >/dev/null && echo "  ✓ esp32_base" || echo "  ✗ esp32_base"
pgrep -f 'teleop_node\.py'     >/dev/null && echo "  ✓ teleop"     || echo "  ✗ teleop"
grep -E "주행로그|우측 채널 부호|ESP32 연결" /tmp/base.log | tail -3
ls -d "$HOME"/drivelog/*/ 2>/dev/null | tail -1
