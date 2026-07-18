# 삐용 (BBIYONG) - 백엔드 개발자용 상세 API 명세서

이 문서는 백엔드(Spring Boot / FastAPI Gateway) 개발자가 DTO 클래스 정의, 컨트롤러 작성, 소켓/웹소켓 핸들러 구현에 바로 적용할 수 있도록 설계된 상세 API 및 통신 프로토콜 명세서입니다.

---

## 1. Web Frontend ↔ Spring Boot REST API 명세

모든 HTTP 요청/응답은 `application/json` 포맷을 사용하며, 예외 발생 시 에러 응답 포맷을 통일합니다.

### 1.0 공통 에러 응답 포맷 (Error Response)
```json
{
  "timestamp": "2026-07-18T19:40:00Z",
  "status": 400,
  "error": "Bad Request",
  "message": "유효하지 않은 입력값입니다.",
  "path": "/api/robots/orinka_01/dispatch"
}
```

---

### 1.1 관리자 인증 API

#### [POST] `/api/auth/login`
* **설명**: 관리자가 ID/PW로 로그인하고 JWT 토큰을 발급받습니다.
* **Request Header**: `Content-Type: application/json`
* **Request Body**:
```json
{
  "username": "admin01",
  "password": "password123!"
}
```
* **Response Body (200 OK)**:
```json
{
  "tokenType": "Bearer",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 86400,
  "role": "ROLE_ADMIN"
}
```

---

### 1.2 로봇 조회 및 제어 API

모든 제어 및 조회 API는 인가 헤더(`Authorization: Bearer <JWT>`)가 필요합니다.

#### [GET] `/api/robots`
* **설명**: 관리자에게 배정된 로봇의 실시간 상태 요약 목록을 조회합니다. (Redis 캐시에서 읽음)
* **Response Body (200 OK)**:
```json
[
  {
    "robotId": "orinka_01",
    "name": "순찰로봇 오린카 1호기",
    "status": "AUTO_PATROL",
    "battery": 92.5,
    "lastConnected": "2026-07-18T19:35:00Z",
    "location": {
      "x": 1.25,
      "y": 3.40,
      "yaw": 0.78
    }
  }
]
```

#### [POST] `/api/robots/{robotId}/mode`
* **설명**: 웹 대시보드에서 로봇의 주행 모드를 **자율 순찰** 또는 **원격 수동 조종** 모드로 전환합니다.
* **Request Body**:
```json
{
  "mode": "MANUAL_CONTROL"
}
```
* `mode` 값: `AUTO_PATROL`(자율 순찰), `MANUAL_CONTROL`(원격 수동 조종)
* **Response Body (200 OK)**:
```json
{
  "robotId": "orinka_01",
  "currentMode": "MANUAL_CONTROL",
  "status": "UPDATED",
  "timestamp": "2026-07-18T19:38:00Z"
}
```

#### [POST] `/api/robots/{robotId}/dispatch`
* **설명**: 관리자가 지도상의 특정 좌표를 지정하여 로봇을 강제 출동시킵니다. (CCTV 감지 지역 등으로 2차 확인 유도)
* **Request Body**:
```json
{
  "x": 15.45,
  "y": 8.12,
  "reason": "CCTV 1차 화재 감지에 따른 2차 근접 확인 지시"
}
```
* **Response Body (200 OK)**:
```json
{
  "robotId": "orinka_01",
  "command": "DISPATCH",
  "status": "SENT",
  "timestamp": "2026-07-18T19:38:05Z"
}
```

#### [POST] `/api/robots/{robotId}/resume`
* **설명**: 2차 확인 상황 종료 후 로봇에게 자율순찰 복귀를 명령합니다. (로봇은 가장 가까운 순찰 스팟으로 돌아가 순찰을 재개합니다.)
* **Request Body**: None (또는 `{}`)
* **Response Body (200 OK)**:
```json
{
  "robotId": "orinka_01",
  "command": "RESUME",
  "status": "SENT",
  "timestamp": "2026-07-18T19:38:10Z"
}
```

---

### 1.3 설비 관리 API

#### [GET] `/api/equipments`
* **설명**: 공장 내부의 감시 대상 설비 목록과 설정 온도를 조회합니다.
* **Response Body (200 OK)**:
```json
[
  {
    "equipmentId": "panel_01",
    "name": "A동 중앙 메인 제어반",
    "thresholdTemperature": 50.0,
    "location": {
      "x": 8.50,
      "y": 3.10
    }
  },
  {
    "equipmentId": "panel_02",
    "name": "B동 용접설비 동력 분전함",
    "thresholdTemperature": 55.0,
    "location": {
      "x": 12.80,
      "y": 14.20
    }
  }
]
```

#### [PUT] `/api/equipments/{equipmentId}`
* **설명**: 특정 설비의 과열 경보 발생 임계 온도를 수정합니다.
* **Request Body**:
```json
{
  "thresholdTemperature": 52.5
}
```
* **Response Body (200 OK)**:
```json
{
  "equipmentId": "panel_01",
  "thresholdTemperature": 52.5,
  "updatedAt": "2026-07-18T19:39:00Z"
}
```

---

### 1.4 이벤트 로그 API

#### [GET] `/api/events`
* **설명**: 화재 및 장비 과열 감지, 로봇 이상 이벤트 이력을 조회합니다. (SQLite에서 페이징 조회)
* **Query Parameters**:
  * `page` (default: 0)
  * `size` (default: 10)
  * `type` (optional: `FIRE`, `OVERHEAT`, `SYSTEM`)
* **Response Body (200 OK)**:
```json
{
  "content": [
    {
      "eventId": 1,
      "type": "FIRE",
      "robotId": "orinka_01",
      "location": { "x": 15.0, "y": 8.2 },
      "confidence": 0.94,
      "temperature": 58.4,
      "timestamp": "2026-07-18T19:30:12Z",
      "status": "UNRESOLVED"
    }
  ],
  "pageable": {
    "pageNumber": 0,
    "pageSize": 10
  },
  "totalPages": 1,
  "totalElements": 1
}
```

---

### 1.5 CCTV 연동 API

#### [POST] `/api/cctv/events`
* **설명**: 공장 천장 등에 고정 설치된 CCTV가 Vision AI 분석을 통해 1차적으로 연기/화재를 탐지했을 때, 백엔드 서버에 알림 이벤트를 발행하는 용도입니다. 백엔드는 이 이벤트를 수집하자마자 순찰 로봇(오린카)에게 해당 좌표로 긴급 출동 명령(`DISPATCH`)을 내립니다.
* **Request Header**: `Content-Type: application/json`
* **Request Body**:
```json
{
  "cctvId": "cctv_04",
  "eventType": "FIRE",
  "location": {
    "x": 15.45,
    "y": 8.12
  },
  "confidence": 0.88,
  "timestamp": "2026-07-18T19:37:00Z"
}
```
* **Response Body (202 Accepted)**:
```json
{
  "status": "DISPATCHED",
  "assignedRobotId": "orinka_01",
  "message": "로봇에 2차 화재 근접 확인 출동 지시를 하달했습니다.",
  "timestamp": "2026-07-18T19:37:02Z"
}
```

---

## 2. Web Frontend ↔ Spring Boot WebSocket 명세

실시간 대시보드 갱신 및 경보 푸시를 담당하며, STOMP 프로토콜을 사용합니다.

### 2.1 연결 엔드포인트
* **WebSocket URL**: `ws://localhost:8080/ws-관제` (STOMP Connection)

### 2.2 Pub/Sub 토픽 및 페이로드

#### 1) 로봇 실시간 텔레메트리 구독 (`SUB /topic/robots`)
* **설명**: 웹 클라이언트가 지도상 로봇 위치, 모드 상태 변경을 실시간 추적합니다.
* **Payload**:
```json
{
  "robotId": "orinka_01",
  "status": "AUTO_PATROL",
  "battery": 88.2,
  "location": {
    "x": 3.42,
    "y": 5.12,
    "yaw": -1.21
  },
  "timestamp": "2026-07-18T19:40:02Z"
}
```
* `status` 값: `AUTO_PATROL`(자율 순찰), `MANUAL_CONTROL`(원격 조종), `DISPATCH`(긴급 출동), `VERIFY`(근접 확인)

#### 2) 실시간 경보 푸시 구독 (`SUB /topic/alerts`)
* **설명**: CCTV 및 로봇에 의해 탐지된 화재/과열 경보 등 발생 시 브라우저에 실시간 경보 모달을 띄우기 위해 사용합니다.
* **Payload**:
```json
{
  "alertId": 1,
  "type": "FIRE",
  "level": "CRITICAL",
  "source": "CCTV",
  "robotId": "orinka_01",
  "location": { "x": 15.45, "y": 8.12 },
  "message": "CCTV(cctv_04)에 의해 1차 화재가 감지되었습니다. 로봇이 출동합니다.",
  "timestamp": "2026-07-18T19:40:03Z"
}
```
* `source` 값: `CCTV` 또는 `ROBOT`

#### 3) 로봇 원격 방향 조종 (WASD) 발행 (`PUB /app/robot/{robotId}/manual-drive`)
* **설명**: 웹 관제 화면에서 수동 조종 모드(`MANUAL_CONTROL`)를 활성화한 상태에서 관리자가 키보드 WASD 키를 누를 때마다 이 엔드포인트로 이동 명령(선속도/각속도 값)을 쏘아 보냅니다. 백엔드는 이 값을 즉시 로봇의 TCP 소켓으로 릴레이합니다.
* **Payload**:
```json
{
  "linear": 0.5,
  "angular": -0.2
}
```
* `linear`: 전진/후진 속도 (m/s) — 전진 (+), 후진 (-)
* `angular`: 회전 각속도 (rad/s) — 좌회전 (+), 우회전 (-)
* 정지 명령 시에는 두 값을 모두 `0.0`으로 전송합니다.

---

## 3. 로봇 ↔ Spring Boot 직접 TCP 소켓 통신 (JSON Lines)

1단계 MVP 아키텍처에 따라 로봇(Client)과 Spring Boot 메인 서버(Server) 간에 수립되는 TCP 소켓 프로토콜입니다. 각 JSON 메시지는 `\n`(개행 문자)로 구분(JSON Lines)하여 실시간 전송합니다.

* **Spring Boot 기본 대기 포트(Port)**: `9000` (설정 파일로 조정 가능)

### 3.1 로봇 $\rightarrow$ Spring Boot (Upstream)

#### 1) 주기적 텔레메트리 패킷 (개행 필수)
```json
{"source": "robot", "type": "TELEMETRY", "robot_id": "orinka_01", "location": {"x": 1.25, "y": 3.40, "yaw": 0.78}, "battery": 92.5, "status": "AUTO_PATROL"}
```
* `status` 값: `AUTO_PATROL`, `MANUAL_CONTROL`, `DISPATCH`, `VERIFY`

#### 2) 이중 판정 화재 이벤트 패킷 (개행 필수)
```json
{"source": "robot", "type": "EVENT_FIRE", "robot_id": "orinka_01", "confidence": 0.94, "temperature": 58.4, "location": {"x": 15.0, "y": 8.2}}
```

#### 3) 장비 과열 이벤트 패킷 (개행 필수)
```json
{"source": "robot", "type": "EVENT_OVERHEAT", "robot_id": "orinka_01", "equipment_id": "panel_01", "temperature": 53.2, "location": {"x": 8.5, "y": 3.1}}
```

### 3.2 Spring Boot $\rightarrow$ 로봇 (Downstream)

#### 1) 출동 명령 패킷 (개행 필수)
```json
{"command": "DISPATCH", "target_location": {"x": 15.0, "y": 8.2}}
```

#### 2) 복귀 명령 패킷 (개행 필수)
```json
{"command": "RESUME"}
```

#### 3) 모드 설정 패킷 (개행 필수)
```json
{"command": "SET_MODE", "mode": "MANUAL_CONTROL"}
```
* `mode` 값: `AUTO_PATROL` 또는 `MANUAL_CONTROL`

#### 4) 수동 조종 방향 패킷 (개행 필수)
```json
{"command": "DRIVE", "linear": 0.5, "angular": -0.2}
```
* `linear`: 전진/후진 속도 (m/s)
* `angular`: 회전 각속도 (rad/s)

---

## 4. [고도화 단계] Gateway (FastAPI) ↔ Spring Boot 연동 명세 (선택사항)

MVP 개발 완료 이후, 비디오 스트리밍 분산 처리 및 포트폴리오 다각화를 위해 **2단계 게이트웨이 아키텍처**로 확장할 경우 사용되는 백엔드 간 연동 규격입니다. (1단계 개발 시에는 생략됩니다.)

* **WebSocket 연결 엔드포인트**: `ws://localhost:8080/ws-gateway`

### 4.1 게이트웨이 $\rightarrow$ 메인 서버 데이터 전송 (Pub)
* `PUB /app/gateway/telemetry`: 로봇 실시간 텔레메트리 갱신
* `PUB /app/gateway/event`: 실시간 화재/과열 이벤트 릴레이

### 4.2 메인 서버 $\rightarrow$ 게이트웨이 명령 전송 (Sub)
* `SUB /topic/gateway/commands`: 웹 대시보드에서 수동으로 내린 제어 명령을 게이트웨이로 전달

