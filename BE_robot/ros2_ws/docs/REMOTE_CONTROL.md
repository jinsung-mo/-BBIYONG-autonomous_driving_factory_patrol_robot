# 원격 수동 제어 (Phase 1)

`remote_control_bridge`는 WSS의 완성된 텍스트 메시지를 ROS 2 수동 제어 토픽으로 옮긴다. 기본값은 꺼짐이고, 연결 직후에도 ESTOP은 **켜진 상태**다. 하드웨어 출력도 별도의 `vehicle.yaml`에서 `hardware_enabled: true`를 명시하기 전에는 0으로 고정된다.

## WSS 명령 계약

```json
{"command":"DRIVE","linear":0.10,"angular":0.20}
{"command":"SET_MODE","mode":"manual"}
{"command":"ESTOP"}
```

- `DRIVE`는 `/cmd_vel/manual`의 `Twist.linear.x`, `Twist.angular.z`로 발행된다. 숫자는 유한값이어야 하며 브리지의 제한값으로 clamp된다.
- `SET_MODE`는 `disabled`, `manual`, `autonomy` 중 하나만 `/bbiyong/control_mode`로 발행한다.
- `ESTOP`는 `/bbiyong/estop=true`만 발행한다. 원격 명령으로 ESTOP을 해제할 수 없으며 `DRIVE`도 절대 해제하지 않는다.
- WSS 연결 실패·끊김·오류·프로세스 종료는 항상 `Twist(0,0)`, `disabled`, `estop=true`를 발행한다.
- 연결되면 가짜 위치/배터리 텔레메트리 대신 `{"type":"REGISTER","robot_id":"..."}`만 전송해 서버 세션을 등록한다. 서버는 이 등록 타입을 조용히 처리하도록 후속 보완이 필요하다.

## 실행

Jetson에서 한 번만 설치한다.

```bash
cd ~/bbiyong_ros2_ws
chmod +x scripts/bbiyong scripts/install-operator.sh
./scripts/install-operator.sh
```

원격 제어를 명시적으로 켜려면 WSS 주소를 환경변수로 준다. 인증 헤더는 아직 운영 인증 설계가 확정되지 않아 런치 인자로만 지원하며, 파일이나 Git에 저장하지 않는다.

```bash
export BBIYONG_WSS_URL='wss://i15e101.p.ssafy.io/ws/robot'
bbiyong control ~/bbiyong_ros2_ws/config/vehicle.yaml --remote
```

`navigate`와 `explore`도 같은 control launch를 포함하므로, 별도 `bbiyong control`을 동시에 실행하지 않는다. 원격 수동 제어를 함께 켜려면 다음처럼 마지막에 `--remote`를 붙인다.

```bash
export BBIYONG_ROBOT_ID='orinka_01' # optional; defaults to orinka_01
bbiyong navigate ~/maps/factory.yaml ~/bbiyong_ros2_ws/config/vehicle.yaml ~/bbiyong_ros2_ws/generated/nav2.yaml --remote
bbiyong explore ~/bbiyong_ros2_ws/config/vehicle.yaml ~/bbiyong_ros2_ws/generated/nav2.yaml ~/maps/auto_factory --remote
```

원격 브리지는 수동 토픽만 제공한다. Nav2 autonomy와 manual은 동일한 mux에 들어가며, 원격 연결만으로 ESTOP이 해제되거나 하드웨어가 활성화되지는 않는다.

일반 운영 명령은 `bbiyong mapping`, `save-map`, `localize`, `navigate`, `control`, `explore`, `status`다. launch는 `exec`로 실행되므로 `Ctrl+C`가 ROS에 직접 전달되고 브리지는 종료 시 fail-safe를 발행한다.

## 웹 조작기 계약

브라우저는 키가 눌린 동안만 10 Hz 이상으로 동일한 `DRIVE` heartbeat를 보내야 한다. `keyup`, 창의 `blur`, 탭의 `visibilitychange`(hidden), WebSocket close/error에서는 즉시 `{ "command":"DRIVE", "linear":0, "angular":0 }`를 보낸다. 이 STOP은 사용자 경험용 보조장치이며, 로봇 쪽 0.5초 mux watchdog과 WSS 연결 해제 fail-safe가 최종 안전장치다.

Ackermann 차량은 제자리 회전이 불가능하다. `linear=0, angular!=0`은 하드웨어 어댑터에서 거부되므로, 조향하려면 아주 낮은 전진/후진 속도와 함께 회전 명령을 보내야 한다.

## 운행 전 안전 게이트

1. 바퀴를 공중에 띄운 상태에서 `/cmd_vel/manual`, `/cmd_vel`, actuator 토픽을 먼저 검증한다.
2. 물리 ESTOP, 배터리, 조향 한계, wheel odom, `vehicle.yaml` 실측값을 확인한다.
3. `hardware_enabled: false` 상태에서 WSS와 ROS 명령만 검증한다.
4. 사람이 즉시 물리 ESTOP을 누를 수 있을 때만 저속으로 `hardware_enabled: true`를 시험한다.

미완료 항목: 실제 모터/PWM 드라이버, encoder odometry publisher, WSS 인증·권한·REGISTER 메시지의 서버 측 명시적 처리, 웹 조작기 소스는 이 저장소에 없다.
