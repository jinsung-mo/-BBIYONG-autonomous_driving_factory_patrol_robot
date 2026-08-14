# 실차 조립 후 검증 체크리스트

순서를 건너뛰지 않는다. 한 단계가 실패하면 모터 전원을 끄고 그 단계부터 해결한다.

## 1. 전원 OFF 상태에서 측정

- 차체 길이/폭, wheelbase
- 최대 조향각과 실제 최소 회전반경
- 구동륜 반지름, encoder CPR, gear ratio
- `base_link` 원점과 LiDAR 장착 위치/방향
- 모터 전진 부호와 steering 좌/우 부호

`vehicle.yaml`을 채우되 `hardware_enabled: false`로 유지한다.
현재 footprint 생성기는 `base_link`가 차체 기하 중심이라는 정의를 사용한다.

## 2. 센서/TF

```bash
ros2 topic hz /scan
ros2 topic echo /scan --once
ros2 run tf2_ros tf2_echo base_link laser_frame
```

LaserScan `range_max`는 10 m, frame은 `laser_frame`이어야 한다. LiDAR가 차체에 수평·강체 고정되어야 한다.

## 3. Encoder odometry

바퀴를 손으로 정확히 한 바퀴 돌려 tick 부호와 CPR을 확인한다. 직선 1 m를 밀었을 때 odom 거리 단위가 m인지 확인한다.

```bash
ros2 topic hz /odom
ros2 topic echo /odom --once
ros2 run tf2_ros tf2_echo odom base_link
```

wheel odom이 TF를 발행할 때 RF2O는 종료한다.

## 4. 바퀴를 띄운 모터 시험

실제 하드웨어 노드가 `/bbiyong/actuator/throttle`과 `/bbiyong/actuator/steering_angle_rad`를 입력받아야 한다. `hardware_enabled: true` 전에 다음을 확인한다.

- 시작/종료/예외 시 throttle 0
- estop true에서 항상 0
- 350 ms 명령 단절 시 0
- 작은 양수 throttle이 전진
- 양수 steering이 설정한 좌/우 방향과 일치
- 조향 saturation이 기구 한계를 넘지 않음

## 5. 바닥 저속 수동 시험

속도 제한을 0.1 m/s로 두고 0.5 m 직선, 좌/우 완만한 곡선, 정지를 시험한다. 차체 실제 궤적과 odom/RViz 궤적을 비교한다.

## 6. 수동 매핑과 저장

`mapping.launch.py odom_source:=wheel`로 작은 구역을 한 바퀴 돌고 지도를 저장한다. 벽이 두 겹이면 LiDAR 고정, encoder scale, yaw 부호, TF 중복을 우선 확인한다.

## 7. AMCL

프로세스를 모두 종료한 뒤 `localization.launch.py`로 저장 지도를 연다. RViz의 `2D Pose Estimate` 후 1~2 m 이동해 LaserScan과 지도 벽이 계속 일치하는지 본다.

## 8. Nav2 근거리 목표

사람이 estop을 누를 준비를 하고 0.5~1 m 앞의 목표부터 시작한다. 경로 생성, 장애물 정지, steering 방향, 최종 정지를 확인한 뒤 거리를 늘린다.

## 9. Frontier 탐색

장애물이 적고 사람이 통제하는 작은 공간에서 frontier 1개만 성공시키고 중단한다. 실패 목표 blacklist, timeout cancel, 자동 지도 저장을 확인한 다음 전체 공간으로 확장한다.
