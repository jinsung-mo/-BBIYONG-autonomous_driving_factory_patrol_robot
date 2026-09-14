#!/usr/bin/env bash
# 로봇 관련 노드를 전부 정지한다.
#
# 왜 스크립트 파일인가: `ssh orin 'pkill -f esp32_base_node'` 처럼 쓰면
# **그 ssh 명령 자신의 명령줄에 패턴이 들어 있어서** pkill이 자기를 죽인다.
# (오늘 세 번 당했다.) 스크립트로 빼면 실행 명령줄은 경로뿐이라 안전하다.

#
# 🔴 패턴은 **경로가 아니라 파일명**으로 쓴다.
#    `python3 ./camera_node.py` 처럼 상대경로로 띄우면 `~/trt/camera_node.py`
#    같은 전체경로 패턴에 안 걸린다. pkill 은 ps 명령줄 문자열만 본다.
NODES="esp32_base_node ydlidar_ros2_driver_node static_transform_publisher
       async_slam_toolbox_node teleop_node camera_node recorder.py
       patrol.py explore.py roam.py bench.py straight_test.py"

for pat in $NODES; do
    pkill -f "$pat" 2>/dev/null
done
sleep 2

# 모터 정지를 시리얼로 직접 한 번 더 보낸다 (노드가 죽으며 못 보냈을 경우 대비).
# 펌웨어 데드맨 1초가 최종 방어선이지만, 확실히 해 둔다.
python3 - <<'PY' 2>/dev/null
import time
try:
    import serial
    s = serial.Serial("/dev/esp32", 115200, timeout=0.3)
    time.sleep(1.8)
    s.write(b"s\n"); s.flush(); time.sleep(0.2)
    s.close()
    print("모터 정지 명령 전송")
except Exception as e:
    print("시리얼 정지 생략:", e)
PY

echo "정지 완료"

# 🔴 검증은 **죽이려 한 목록 전체**를 다시 세야 한다.
#    예전엔 ydlidar·esp32 둘만 세서, teleop 이 살아 있어도 "0개"를 찍었다.
#    그 0을 보고 "전부 정지"라고 보고했는데 사실이 아니었다 (2026-07-26).
#    검증이 검증 대상을 포함하지 않으면 그건 검증이 아니다.
left=0
for pat in $NODES; do
    n=$(pgrep -fc "$pat" 2>/dev/null || true)
    if [ "${n:-0}" -gt 0 ]; then
        echo "  ⚠️ 남아 있음: $pat (${n}개)"
        left=$((left + n))
    fi
done
echo "남은 노드 ${left}개"
