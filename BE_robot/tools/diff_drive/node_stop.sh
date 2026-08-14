#!/usr/bin/env bash
# esp32_base_node·teleop_node 만 내려 시리얼을 반환한다.
# (라이다·SLAM·카메라·대시보드는 계속 둔다)
#
# 스크립트로 만든 이유: ssh 명령줄에 패턴이 있으면 pkill 이 자기를 죽인다.
pkill -f 'python3 .*teleop_node\.py' 2>/dev/null
pkill -f 'python3 .*esp32_base_node\.py' 2>/dev/null
sleep 3
if pgrep -f 'esp32_base_node\.py' >/dev/null; then
    echo "경고: esp32_base 잔존 — 강제 종료"
    pkill -9 -f 'python3 .*esp32_base_node\.py' 2>/dev/null
    sleep 1
fi
pgrep -f 'esp32_base_node\.py' >/dev/null && echo "🔴 아직 살아 있다" || echo "✅ 시리얼 반환됨"
