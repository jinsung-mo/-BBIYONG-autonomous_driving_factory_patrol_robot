# 차동구동(differential drive) 전환 메모

> 실물 섀시는 **좌우 구동륜 2개 + 캐스터**다. 조향 서보가 없다.
> `bbiyong_base` / `bbiyong_bringup` 은 Ackermann 전제로 짜여 있어 두 구동학이
> 한 저장소에 공존한다. 이 문서는 **어디가 갈라져 있는지**를 적는다.

## 1. 실측 파라미터 (vehicle.yaml 에 넣을 값)

`vehicle.example.yaml` 은 템플릿이라 전부 `null` 로 둔다. 아래는 실측 확정값이고,
`vehicle.yaml`(gitignored)에 넣어야 한다.

```yaml
vehicle:
  drive_type: differential
  track_width_m: 0.2091          # odom vs 라이다 교차검증. 적용 후 회전오차 0.2%
  left_wheel_direction: 1
  right_wheel_direction: 1       # 🔴 -1 금지 (아래 §3)
  max_linear_speed_mps: 0.10
  max_angular_speed_rps: 0.30

wheel_odometry:
  wheel_radius_m: 0.031145       # 유효지름 62.29mm (명목 65mm 의 95.8%)
  encoder_cpr: 1197              # 정지 분할 실측 (좌 1200 / 우 1195, 편차 0.44%)

lidar:                            # base_link(구동축 중심) -> 라이다
  x_m: 0.0597
  y_m: -0.0051
  yaw_rad: 0.0752                # +4.31도
```

측정 방법과 산포는 개인 저장소 `docs/실측_데이터.md` §F·§J·§K·§M 참조.

🔴 **윤거는 차체에 종속된 값이다.** 지금 값은 현재 섀시 기준이고,
새 차체(윤거 ~310mm)로 갈아타면 무효가 된다 — 조립 후 재측정 필수.

## 2. Ackermann 코드와 갈라지는 지점

| 위치 | Ackermann | 차동 | 처리 |
|---|---|---|---|
| `kinematics.py` | `twist_to_ackermann` | `twist_to_differential` | 함수 추가 (원본 무수정) |
| `VehicleLimits` | `wheelbase_m`·`max_steering_angle_rad` | `track_width_m`·좌우 방향 | 필드 추가 + `for_differential()` |
| 검증 | `validate()` | `validate_differential()` | 조향축 없는 항목만 검사 |
| 어댑터 노드 | `ackermann_adapter_node.py` | `differential_adapter_node.py` | 파일 분리 |
| 출력 토픽 | `/bbiyong/actuator/throttle`·`steering` | `/bbiyong/actuator/wheel_left`·`wheel_right` | 분리 |
| 런치 | `control.launch.py` | 〃 (`drive_type` 분기) | 한 파일에서 분기 |
| Nav2 | `nav2_ackermann.template.yaml` | `nav2_diff.yaml` | 파일 분리 |
| 플래너 | `SmacPlannerHybrid` + `DUBIN` + `min_turning_radius 0.40` | `SmacPlanner2D` | 최소 회전반경 제약 없음 |
| BT | `navigate_to_pose_ackermann.xml` (Spin 제거) | Nav2 기본 BT (Spin 포함) | 제자리 회전이 정상 명령 |
| 제자리 회전 | 거부 (`rejected_in_place_rotation`) | 허용 | — |
| `amcl` | `DifferentialMotionModel` | 동일 | 원본이 이미 차동이었다 |

**Ackermann 경로는 하나도 삭제하지 않았다.** `drive_type` 으로 고른다.

## 3. 🔒 부호 규약 — `right_wheel_direction` 은 반드시 `+1`

물리 실측으로는 전진 시 좌 엔코더가 `+`, 우 엔코더가 `−` 다(좌우 모터가 거울
대칭 장착). 그런데 **`speed_pid.ino` 펌웨어가 이 대칭을 이미 흡수한다.**
펌웨어 바깥에서는 양쪽 다 `+` 가 전진이고, 텔레메트리도 둘 다 양수로 보고된다.

여기서 `right_wheel_direction: -1` 을 주면 **이중 반전**이 되어 전진 명령에
제자리 회전을 한다. MDD10A 출력은 H브리지라 극성 개념이 없으므로 **배선 교체로
고치려 하지 말 것** (단, 전원 입력 B+/B− 역극성은 보드가 죽는다).

## 4. 미측정 값을 다루는 방식

`track_width_m` 이 없으면 **값을 추측하지 않고 좌우 출력을 0 으로 막는다**
(`DifferentialCommand.unconfigured_track_width`). ROS 파라미터는 null 을 실을 수
없어 런치가 `or 0.0` 으로 내리고, 어댑터가 `0.0` 을 "미측정"으로 되돌린다.

이 프로젝트에서 **네 개의 스펙값이 "재지 않고 베껴 와서" 틀렸다**
(CPR 1300, 11 PPR, 바퀴지름 85mm, 무부하 데드밴드). 그래서 기본값을 주지 않는다.

## 5. 남은 것

- 🔴 `vehicle_config.py` 의 strict 검증이 `drive_type` 과 무관하게
  `wheelbase_m` 을 요구한다. 차동구동에는 없는 값이라 `hardware_enabled: true`
  로 못 올라간다. **스키마에서 빼야 한다** — 값을 지어내면 안 된다.
- 🔴 오도메트리 소스: `rf2o` 는 정지 상태에서 yaw 가 10분간 200도 배회한다
  (라이다 데이터 자체는 정상임을 교차상관으로 확인). 그래서 휠 오도메트리
  (`esp32_base_node.py`)를 쓴다.
- 좌우 3~4% 격차가 게인과 무관하게 잔존. 오도메트리는 정직해서 매핑엔 무해.
- laser_yaw 방향은 ±0.5도로 맞는데 이동거리가 라이다 > 오도 11~14%. 원인 미규명.
