#!/usr/bin/env bash
# 대시보드 서버 + nav_bridge 재시작.
#
# 스크립트로 뺀 이유: `ssh orin 'pkill -f server.py'` 처럼 쓰면 그 ssh 명령
# 자신의 명령줄에 패턴이 들어 있어 pkill 이 자기를 죽인다. (여러 번 당했다.)
# 여기서는 실행 명령줄이 스크립트 경로뿐이라 안전하다.
DASH="$HOME/orin-dashboard"
PORT="${1:-8090}"

# ⚠️ 패턴은 **ps 에 보이는 명령줄** 기준이어야 한다. 아래에서 `cd $DASH` 후
#    `python3 server.py` 로 띄우므로 명령줄에 경로가 없다 —
#    'orin-dashboard/server.py' 같은 경로 패턴은 아무것도 못 잡는다.
pkill -f 'python3 server\.py' 2>/dev/null
pkill -f 'python3 nav_bridge\.py' 2>/dev/null
sleep 2
if pgrep -f 'python3 server\.py' > /dev/null; then
    echo "경고: 기존 서버가 아직 살아 있다"; pkill -9 -f 'python3 server\.py'; sleep 1
fi

source /opt/ros/humble/setup.bash
source "$HOME/ydlidar_ros2_ws/install/setup.bash" 2>/dev/null

cd "$DASH" || exit 1
setsid nohup python3 nav_bridge.py \
    --live /tmp/orincar_nav_live.json \
    --map /tmp/orincar_nav_map.json \
    --update /tmp/orincar_nav_map_update.json \
    --hz 2 \
    < /dev/null > /tmp/navbridge.log 2>&1 &
disown
sleep 3
setsid nohup python3 server.py --port "$PORT" \
    < /dev/null > /tmp/dash.log 2>&1 &
disown
sleep 3

code=$(curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT/api/nav/live")
age=$(curl -s -D- -o /dev/null "localhost:$PORT/api/nav/live" | grep -i '^x-nav-age' | tr -d '\r')
echo "api/nav/live HTTP $code · $age"
curl -s -o /dev/null -w 'nav.html HTTP %{http_code} (%{size_download} bytes)\n' \
    "localhost:$PORT/nav.html"
