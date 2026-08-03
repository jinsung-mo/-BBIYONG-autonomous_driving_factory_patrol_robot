# BBIYONG ROS 2: 2D SLAM, Nav2, Frontier Exploration

Jetson Orin Nano와 10 m YDLIDAR를 위한 ROS 2 Humble 워크스페이스다. 카메라/YOLO 예제와 별개이며, ROS 코드는 `AI`가 아니라 `BE_robot/ros2_ws`에서 관리한다.

## 현재 가능한 범위

- `RF2O + SLAM Toolbox` 손 매핑 및 지도 저장
- 저장 지도에서 `AMCL` 위치 추정
- Nav2 Hybrid-A* 경로 계획과 Regulated Pure Pursuit 제어
- Frontier 자동 탐색 목표 선택, 실패 지점 임시 제외, 완료 후 지도 자동 저장
- 수동/자율 명령 중재, 비상정지, 350 ms 명령 watchdog
- Ackermann `Twist → throttle/steering` 변환

아직 실제 모터 API와 encoder 메시지 형식이 정해지지 않았으므로 실제 PWM/I2C 출력과 wheel odometry 생성은 의도적으로 구현하지 않았다. 현재 actuator adapter는 `/bbiyong/actuator/throttle`과 `/bbiyong/actuator/steering_angle_rad`까지만 발행한다.

## 좌표계와 실행 모드

필수 TF 체인은 다음 하나뿐이어야 한다.

```text
map -> odom -> base_link -> laser_frame
```

| 모드 | `map -> odom` | `odom -> base_link` | 용도 |
|---|---|---|---|
| mapping | SLAM Toolbox | RF2O 또는 wheel odom 중 하나 | 새 지도 작성 |
| localization/navigation | AMCL | RF2O 또는 wheel odom 중 하나 | 저장 지도 위치 추정/주행 |

두 모드를 동시에 실행하지 않는다. RF2O와 wheel odom도 동시에 TF를 발행하면 안 된다. YDLIDAR 기본 launch를 별도로 실행한 상태에서 이 bringup을 또 실행하면 `/scan`, serial port, static TF가 중복되므로 기존 프로세스를 먼저 `Ctrl+C`로 종료한다.

## 패키지

- `bbiyong_bringup`: 센서/SLAM/Nav2 launch, 차량 설정 검증, 지도 저장
- `bbiyong_explorer`: 도달 가능한 자유 셀 기반 Frontier 탐색
- `bbiyong_base`: 명령 mux, estop/watchdog, Ackermann 명령 변환

## Jetson 설치와 빌드

PC의 프로젝트 루트에서 PowerShell로 Jetson에 복사한다. `ssh orin`이 먼저 성공해야 한다.

```powershell
ssh orin "mkdir -p ~/bbiyong_ros2_ws"
scp -r .\S15P11E101\BE_robot\ros2_ws\src orin:~/bbiyong_ros2_ws/
scp .\S15P11E101\BE_robot\ros2_ws\README.md orin:~/bbiyong_ros2_ws/
scp .\S15P11E101\BE_robot\ros2_ws\dependencies.repos orin:~/bbiyong_ros2_ws/
```

이후 명령은 `ssh orin`으로 들어간 Jetson 터미널에서 실행한다.

기존에 설치한 YDLIDAR와 RF2O 워크스페이스를 먼저 source한다.

```bash
source /opt/ros/humble/setup.bash
source ~/ydlidar_ros2_ws/install/setup.bash
source ~/rf2o_ws/install/setup.bash

cd ~/bbiyong_ros2_ws
rosdep install --from-paths src --ignore-src -r -y \
  --skip-keys "ydlidar_ros2_driver rf2o_laser_odometry"
colcon build --symlink-install
source install/setup.bash
```

새 Jetson에서 소스를 다시 받을 때는 `dependencies.repos`에 고정된 커밋을 사용한다. YDLIDAR는 별도로 YDLidar-SDK 설치가 필요하다.

```bash
cd ~/bbiyong_ros2_ws
vcs import src < dependencies.repos
```

새 터미널마다 네 줄의 `source`가 필요하다. `.bashrc`에 넣기 전에는 오타가 없는지 직접 실행해 확인한다. 기존 `.bashrc`의 `soutce` 오타는 `source`로 고쳐야 한다.

## 오늘: 손으로 새 지도 만들기

차량 제원과 LiDAR 장착 위치가 아직 없으므로 bench 전용 옵션을 쓴다.

```bash
source /opt/ros/humble/setup.bash
source ~/ydlidar_ros2_ws/install/setup.bash
source ~/rf2o_ws/install/setup.bash
source ~/bbiyong_ros2_ws/install/setup.bash

ros2 launch bbiyong_bringup mapping.launch.py \
  odom_source:=rf2o \
  allow_unmeasured_lidar:=true
```

RViz 설정:

1. `Fixed Frame`을 `map`으로 선택한다.
2. `Add` → `Map`, Topic `/map`을 선택한다.
3. `Add` → `LaserScan`, Topic `/scan`을 선택한다.
4. 필요하면 `Add` → `TF`로 좌표계 연결을 확인한다.

LiDAR를 수평으로 고정하고 허리~가슴 높이에서 천천히 이동한다. 같은 벽을 왕복할 때 높이와 기울기를 바꾸지 말고, 급회전 대신 제자리에서 천천히 회전한다. 출발 지점으로 돌아와 loop closure가 일어나는지 확인한다.

지도 저장:

```bash
ros2 run bbiyong_bringup save_map ~/maps/handheld_map
ls -lh ~/maps/handheld_map.pgm ~/maps/handheld_map.yaml
```

저장 timeout은 기본 10초이며 두 파일이 없거나 비어 있으면 실패로 처리한다.

## 저장 지도에서 위치 추정

기존 mapping launch를 `Ctrl+C`로 완전히 종료하고 실행한다.

```bash
ros2 launch bbiyong_bringup localization.launch.py \
  map:=/home/e101/maps/handheld_map.yaml \
  odom_source:=rf2o \
  allow_unmeasured_lidar:=true
```

RViz에서 `2D Pose Estimate`를 눌러 지도상의 현재 위치와 방향을 드래그한다. 다음으로 확인한다.

```bash
ros2 topic echo /amcl_pose --once
ros2 run tf2_ros tf2_echo map base_link
```

로봇을 조금 움직였을 때 RViz의 LaserScan이 저장 지도 벽과 계속 겹치면 위치 추정이 동작하는 것이다. 손으로 든 RF2O는 임시 검증용이며, 실차에서는 encoder 기반 wheel odom으로 바꾼다.

## Nav2 목적지 설정: 모터 없는 dry-run

```bash
ros2 launch bbiyong_bringup navigation.launch.py \
  map:=/home/e101/maps/handheld_map.yaml \
  odom_source:=rf2o \
  allow_unmeasured_lidar:=true
```

RViz에서 `2D Pose Estimate` 후 `Nav2 Goal` 또는 `2D Goal Pose`로 목적지를 정한다. `hardware_enabled: false`이므로 경로는 계산하지만 actuator 출력은 항상 0이다.

```bash
ros2 topic echo /plan --once
ros2 topic echo /bbiyong/actuator/throttle
```

## 차량 완성 후 설정

설정 파일을 복사하고 실제 측정값만 입력한다.

```bash
mkdir -p ~/bbiyong_ros2_ws/config ~/bbiyong_ros2_ws/generated
cp ~/bbiyong_ros2_ws/src/bbiyong_bringup/config/vehicle.example.yaml \
  ~/bbiyong_ros2_ws/config/vehicle.yaml
nano ~/bbiyong_ros2_ws/config/vehicle.yaml
```

필수값:

- `drive_type`: 실제 조향 방식
- `wheelbase_m`, `width_m`, `length_m`
- `base_link_reference: geometric_center` (`base_link`를 차체 기하 중심으로 정의)
- `max_steering_angle_deg`, `min_turning_radius_m`
- 안전하게 제한한 최대 선속도/각속도
- `base_link` 기준 LiDAR x/y/z 및 roll/pitch/yaw
- encoder wheel radius, CPR와 실제 odom publisher

처음에는 `hardware_enabled: false`로 둔다. 입력 후 검증하고 Nav2 설정을 생성한다.

```bash
ros2 run bbiyong_bringup validate_vehicle_config \
  ~/bbiyong_ros2_ws/config/vehicle.yaml

ros2 run bbiyong_bringup generate_nav2_config \
  --vehicle ~/bbiyong_ros2_ws/config/vehicle.yaml \
  --template "$(ros2 pkg prefix --share bbiyong_bringup)/config/nav2_ackermann.template.yaml" \
  --output ~/bbiyong_ros2_ws/generated/nav2.yaml
```

실제 제어 직전 `configured: true`, `hardware_enabled: true`로 변경하고 strict 검증을 통과해야 한다.

```bash
ros2 run bbiyong_bringup validate_vehicle_config \
  ~/bbiyong_ros2_ws/config/vehicle.yaml --strict-hardware
```

## 실차 Nav2 주행

encoder 노드가 `/odom`과 `odom -> base_link`를 발행하는 상태에서 실행한다.

```bash
ros2 launch bbiyong_bringup navigation.launch.py \
  map:=/home/e101/maps/factory.yaml \
  vehicle_config:=/home/e101/bbiyong_ros2_ws/config/vehicle.yaml \
  nav2_params:=/home/e101/bbiyong_ros2_ws/generated/nav2.yaml \
  odom_source:=wheel
```

Nav2 출력은 `/cmd_vel/autonomy`, 수동 명령은 `/cmd_vel/manual`로 들어간다. mux만 최종 `/cmd_vel`을 발행한다. 시작 시 mode가 `disabled`이고 estop이 켜져 있다.

실제 hardware adapter 구현 후, 바퀴를 공중에 띄운 상태에서만 다음 잠금 해제를 한다.

```bash
ros2 topic pub --once /bbiyong/estop std_msgs/msg/Bool "{data: false}"
ros2 topic pub --once /bbiyong/control_mode std_msgs/msg/String "{data: autonomy}"
```

즉시 정지:

```bash
ros2 topic pub --once /bbiyong/estop std_msgs/msg/Bool "{data: true}"
```

마지막 유효 명령 후 0.35초가 지나면 throttle은 0이 된다. Ackermann 차량에 `linear.x=0`, `angular.z!=0`인 제자리 회전 명령이 들어오면 정지로 거부한다.

## 자동 Frontier 매핑

실차 wheel odom, 측정 차량 설정, 생성 Nav2 설정, 실제 motor adapter가 모두 준비된 뒤 실행한다.

```bash
bbiyong mapping-runtime /home/e101/bbiyong_ros2_ws/generated/nav2.yaml
```

This persistent runtime owns Nav2, Collision Monitor, exactly one command mux,
the control-state authority, and the guarded manual-drive bridge. Do not run the
legacy `tools/teleop_node.py` beside it because that node bypasses the mux by
publishing directly to `/cmd_vel`.

Manual cloud commands are file-backed and enter only `/cmd_vel/manual`. The
bridge applies finite-value checks, speed limits, acceleration ramps, a command
deadman, and a directional LiDAR stop before the mux. The runtime starts in
`disabled` with e-stop engaged; arming is always explicit.

For saved-map scouting, stop the mapping session through its owner and run:

```bash
bbiyong scouting-runtime /home/e101/maps/factory.yaml
```

This starts map-server and AMCL without duplicating the externally owned
sensors/odometry stack. The scouting guard keeps motion stopped until exactly
one `/map` publisher, one `map -> odom` authority, active lifecycle nodes, a
valid `/amcl_pose`, and `map -> base_link` TF are present. It never kills
`slam_toolbox`; the operator must stop that mapping session first.

Before hardware rollout, follow
[`docs/PHASE7_COMMISSIONING.md`](docs/PHASE7_COMMISSIONING.md). The `bbiyong
commission-check`, `bbiyong collect-evidence`, and `bbiyong release` commands
support non-moving checks, redacted evidence, immutable deployment, and atomic
rollback. Actual movement remains an attended post-rebuild activity.

With the scouting runtime healthy, `bbiyong patrol <route.json>` starts the short-lived
`FollowWaypoints` mission. It never publishes velocity directly. It waits for
`autonomy`, pauses/cancels on manual, disabled, e-stop, or SIGTERM, retains the
last unfinished waypoint for resume, reports missed indexes, and optionally
loops. Route replacement cancels the active goal and starts the validated new
route. `bbiyong navigate-goal <x> <y> [yaw]` preempts patrol through the
navigation orchestrator and uses `NavigateToPose`.

Keep that terminal running. In another terminal, start the short-lived mission:

```bash
bbiyong explore /home/e101/maps/auto_factory
bbiyong arm-autonomy
```

동작 순서:

1. SLAM Toolbox가 새 `/map`을 만든다.
2. explorer가 현재 위치에서 연결된 자유 공간만 flood-fill한다.
3. 미지 영역과 맞닿은 자유 셀을 묶고, 벽 clearance를 통과한 목표를 고른다.
4. 정보 이득과 이동 거리로 점수를 계산해 Nav2 `NavigateToPose`에 보낸다.
5. timeout/실패 목표는 120초 blacklist하고 다른 목표를 고른다.
6. 최소 지도 크기를 넘고 15초 동안 목표가 없으면 완료 처리한다.
7. 지도 저장을 최대 3회 재시도하고 `auto_factory.pgm/.yaml`을 저장한다.

상태 확인:

```bash
ros2 topic echo /frontier_explorer/state
ros2 topic echo /frontier_explorer/completed
ros2 topic echo /exploration_map_saver/saved
```

## 주요 진단 명령

navigation/exploration launch는 control mux를 포함하므로 별도의 control launch를 중복 실행하지 않는다. Jetson operator wrapper는 `mapping`, `save-map`, `localize`, `navigate`, `control`, `explore`, `status` 명령을 제공한다.

```bash
ros2 topic hz /scan
ros2 topic hz /odom
ros2 topic hz /map
ros2 topic info /cmd_vel -v
ros2 run tf2_tools view_frames
ros2 doctor --report
```

정상 조건:

- `/scan`, `/odom`, `/map`이 계속 발행됨
- `map -> odom -> base_link -> laser_frame`가 끊기지 않음
- 각 TF child frame의 publisher가 하나뿐임
- Nav2 Goal 전에 costmap에서 로봇 footprint가 장애물과 겹치지 않음
- estop 또는 cmd timeout에서 throttle이 즉시 0

내일 실차 순서는 [docs/TOMORROW_CHECKLIST.md](docs/TOMORROW_CHECKLIST.md)를 따른다.
