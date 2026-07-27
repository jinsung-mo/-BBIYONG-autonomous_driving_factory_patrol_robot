# bbiyong_explorer

`slam_toolbox`가 발행하는 미완성 `/map`에서 frontier(탐색한 빈 공간과 미탐색
공간의 경계)를 찾고, 가장 가치가 높은 지점을 Nav2 `NavigateToPose` 목표로
전송하는 ROS 2 Humble 패키지입니다.

이 패키지는 차량 모터를 직접 제어하지 않습니다. 실행 전에 Nav2가
`/navigate_to_pose` 액션을 제공하고, TF에 `map -> ... -> base_link`가 존재해야
합니다.

## 동작

1. 로봇에서 도달 가능한 free cell만 flood-fill 합니다.
2. free cell 중 unknown cell과 맞닿은 셀을 frontier로 분류합니다.
3. 연결된 frontier를 묶고 크기(정보 이득)와 로봇으로부터 거리를 점수화합니다.
4. 선택한 지점을 Nav2 목표로 보냅니다.
5. 실패하거나 제한 시간을 넘긴 목표는 일정 시간 blacklist에 넣습니다.
6. 도달 가능한 frontier가 연속으로 없으면 탐색 완료를 발행합니다.

## 빌드와 테스트

```bash
cd ~/bbiyong/BE_robot/ros2_ws
source /opt/ros/humble/setup.bash
colcon build --symlink-install --packages-select bbiyong_explorer
source install/setup.bash
colcon test --packages-select bbiyong_explorer
colcon test-result --verbose
```

## 단독 실행

LiDAR, 실제 odometry, `slam_toolbox`, Nav2가 먼저 실행된 상태에서:

```bash
ros2 run bbiyong_explorer frontier_explorer --ros-args \
  --params-file $(ros2 pkg prefix bbiyong_explorer)/share/bbiyong_explorer/config/exploration.yaml
```

상태 토픽:

- `/frontier_explorer/state`: `waiting_for_map`, `navigating`, `completed` 등 문자열
- `/frontier_explorer/completed`: 모든 도달 가능 frontier가 사라지면 `true`

`completed=true`는 지도 저장을 직접 실행하지 않습니다. bringup 또는 상위
오케스트레이터가 이 신호를 받아 `map_saver_cli`를 호출해야 합니다.

## 주요 파라미터

- `min_cluster_size`: 작은 지도 노이즈를 frontier 후보에서 제거합니다.
- `min_frontier_distance`: 현재 위치 바로 주변의 목표를 제외합니다.
- `information_gain_weight`: 긴 frontier를 우선하는 가중치입니다.
- `distance_weight`: 가까운 frontier를 우선하는 가중치입니다.
- `goal_timeout_sec`: 한 목표에 머무를 최대 시간입니다.
- `blacklist_radius`, `blacklist_ttl_sec`: 실패 목표 주변을 임시 제외합니다.
- `completion_confirmations`: 일시적인 지도 공백으로 조기 종료하지 않도록 합니다.

차량 footprint, 속도, 조향각, LiDAR 범위는 Nav2/SLAM/센서 패키지에서
설정하며 이 패키지에는 하드코딩하지 않습니다.
