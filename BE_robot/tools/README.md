# BE_robot/tools — Orin 온보드 실행 스크립트

`ros2_ws/src/` 의 ament 패키지와 **별개**다. 여기 있는 것은 colcon 이 빌드하지
않는 단독 실행 스크립트이고, Orin 에 `scp` 로 배포해서 `python3` 로 직접 띄운다.
현재 로봇을 실제로 굴리고 있는 코드가 이쪽이라 저장소에 남긴다.

## 배포 경로

| 저장소 경로 | Orin 경로 | 역할 |
|---|---|---|
| `tools/diff_drive/esp32_base_node.py` | `~/calib/` | `/cmd_vel` → ESP32, `/odom` + TF. **시리얼 포트 단독 소유자** |
| `tools/diff_drive/patrol.py` | `~/calib/` | 라이다 + 카메라 융합 순찰 |
| `tools/diff_drive/teleop_node.py` | 배포 금지 | 퇴역 안내 전용; 영속 `bbiyong_manual_drive_bridge` 사용 |
| `tools/diff_drive/explore.py` | `~/calib/` | 프런티어 탐사 |
| `tools/diff_drive/roam.py` · `roam_ros.py` | `~/calib/` | 라이다 단독 주행기 (patrol 이전 세대) |
| `tools/diff_drive/bench.py` | `~/calib/` | 실험 하네스 (step/sweep/tune/trace) |
| `tools/diff_drive/odom_check.py` | `~/calib/` | 오도메트리 vs 라이다 교차검증 |
| `tools/diff_drive/map_snapshot.py` | `~/calib/` | `/map` → PGM 저장 |
| `tools/diff_drive/straight_test.py` · `deadband.py` | `~/calib/` | 직진성·데드밴드 측정 |
| `tools/diff_drive/openloop_test.py` | `~/calib/` | **오픈루프 단독 구동 시험** — PID 를 우회해 모터+드라이버만 본다. 교차 배선까지 판정 |
| `tools/diff_drive/drive_diag.py` | `~/calib/` | **주행로그(`trace.csv`) 분석** — 바퀴별 부호일치·duty 포화·추종비로 원인 후보 제시 |
| `tools/diff_drive/counts.sh` | `~/calib/` | 엔코더 카운트만 관측 (모터 무동작 — 손으로 돌려도 읽힌다) |
| `tools/diff_drive/node_stop.sh` | `~/calib/` | `esp32_base_node`·`teleop_node` 만 내려 **시리얼 반환** (라이다·SLAM 은 유지) |
| `tools/diff_drive/base_relog.sh` | `~/calib/` | `esp32_base_node` 를 **주행로그 켠 채로** 재기동 |
| `tools/diff_drive/slam_params.yaml` | `~/calib/` | slam_toolbox 설정 (단독 실행용) |
| `tools/calibration/stack_up.sh` · `stop_all.sh` | `~/calib/` | 스택 기동 · 전부 정지 |
| `tools/calibration/*.py` | `~/calib/` | 벽거리 · 라이다 오프셋 · 요각 · 엔코더 측정 |
| `tools/perception/*` | `~/trt/` | TensorRT 추론 (화재탐지 + 낮은 장애물) |
| `firmware/speed_pid/speed_pid.ino` | `~/sketches/speed_pid/` | 바퀴별 속도 PID (FF+PI, 50Hz) |

## 기동 · 정지

```bash
ssh orin '~/calib/stack_up.sh'                       # 전체 기동 (지도 새로)
ssh orin '~/calib/stack_up.sh keepmap'               # 지도 유지
ssh orin 'python3 ~/calib/patrol.py 300 0.11 0.30'   # 5분 순찰
ssh orin 'python3 ~/calib/map_snapshot.py /tmp/map'  # 지도 저장(PGM)
ssh orin '~/calib/stop_all.sh'                       # 전부 정지
```

## 🔴 반드시 지킬 것

- **ESP32 시리얼 포트는 `esp32_base_node.py` 가 단독 소유한다.** `bench.py`,
  `roam.py`, `deadband.py` 같은 실험 스크립트는 포트를 직접 연다. 동시에 띄우면
  충돌한다 — 하나만 실행할 것.
- **`ssh orin 'pkill -f <패턴>'` 을 쓰지 말 것.** 그 ssh 명령 자신의 명령줄에
  패턴이 들어 있어 pkill 이 자기를 죽인다. `stop_all.sh` 처럼 스크립트 파일로
  분리하면 안전하다.
- 포트는 udev 심볼릭(`/dev/esp32`, `/dev/ydlidar`)만 쓴다. 물리 노드
  (`ttyUSB0/1`)는 꽂는 순서에 따라 바뀐다.

## 부호 규약

전진 시 물리 엔코더는 좌 `+` / 우 `−` 지만, **`speed_pid.ino` 가 이 거울 대칭을
이미 흡수한다.** 펌웨어 바깥에서는 양쪽 다 `+` = 전진이다.
따라서 ROS 쪽 `right_wheel_direction` 은 반드시 `+1` 이어야 한다 — `−1` 을 주면
이중 반전이 되어 제자리 회전한다.
