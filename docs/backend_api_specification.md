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
  "path": "/api/auth/login"
}
```

---

### 1.1 관리자 인증 API (이메일 기반)

#### [POST] `/api/auth/signup`
* **설명**: 관리자 계정을 이메일 기반으로 신규 등록합니다. 비밀번호는 BCrypt 등으로 해시하여 저장합니다.
* **Request Header**: `Content-Type: application/json`
* **Request Body**:
```json
{
  "email": "safety@bbiyong.io",
  "password": "bbiyong",
  "name": "E101 관리자"
}
```
* **Response Body (201 Created)**:
```json
{
  "status": "SUCCESS",
  "email": "safety@bbiyong.io",
  "name": "E101 관리자"
}
```
* **에러**: 이미 존재하는 이메일이면 `409 Conflict`.

#### [POST] `/api/auth/login`
* **설명**: 관리자가 이메일/비밀번호로 로그인하고 JWT 토큰을 발급받습니다.
* **Request Header**: `Content-Type: application/json`
* **Request Body**:
```json
{
  "email": "safety@bbiyong.io",
  "password": "bbiyong"
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

> **제어는 REST가 아니라 STOMP**: 로봇 실시간 제어(모드/주행/ESTOP/맵저장/좌표이동)는 STOMP `/app/control/*` 로 전달되어 로봇 WSS로 중계된다([2.2](#22-pubsub-토픽-및-페이로드) 및 [3.2](#32-spring-boot-rightarrow-로봇-downstream)). REST는 인증과 조회(read)만 담당한다.

#### [MVP][GET] `/api/robots`
* **설명**: 관리자에게 배정된 로봇의 실시간 상태 요약 목록을 조회합니다. (Spring Boot In-Memory 캐시에서 읽음)
* **Response Body (200 OK)**:
```json
[
  {
    "robotId": "orinka_01",
    "name": "삐용 순찰 로봇",
    "status": "AUTO_PATROL",
    "battery": 71.0,
    "speed": 0.6,
    "estop": "RELEASED",
    "commLatencyMs": 43,
    "inferenceFps": 8.0,
    "ambientTemp": 24.8,
    "humidity": 39.0,
    "lastConnected": "2026-07-18T19:35:00Z",
    "location": { "x": 1.25, "y": 3.40, "yaw": 0.78 }
  }
]
```
* `status`(보고 상태)는 로봇이 보고하는 상위 FSM 상태이며, 제어 명령 `mode`(`autonomy`/`manual`/`disabled`)와는 별개 축이다.

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
  "battery": 71.0,
  "speed": 0.6,
  "estop": "RELEASED",
  "commLatencyMs": 43,
  "inferenceFps": 8.0,
  "ambientTemp": 24.8,
  "humidity": 39.0,
  "location": {
    "x": 3.42,
    "y": 5.12,
    "yaw": -1.21
  },
  "timestamp": "2026-07-18T19:40:02Z"
}
```
* `status` 값: `AUTO_PATROL`(자율 순찰), `APPROACH`(화재 후보 위치 자율 접근), `VERIFY`(근접 교차검증), `MANUAL_CONTROL`(원격 조종), `MAPPING`(2D 도면 매핑 중, 후속)
* 확장 필드: `speed`(m/s), `estop`(`RELEASED`/`ENGAGED`), `commLatencyMs`, `inferenceFps`, `ambientTemp`(℃), `humidity`(%)

#### 2) 실시간 경보 푸시 구독 (`SUB /topic/alerts`)
* **설명**: 순찰 로봇이 화재 후보를 근접 교차검증(YOLO 객체탐지 + 열화상)하여 **화재로 확정한 시점**에 발행되는 경보입니다. 브라우저에 실시간 경보 모달을 띄우기 위해 사용합니다. (접근/검증 진행 단계는 경보가 아닌 `/topic/robots` 상태로만 반영됩니다.)
* **Payload**:
```json
{
  "alertId": 1,
  "type": "FIRE",
  "level": "CRITICAL",
  "source": "ROBOT",
  "robotId": "orinka_01",
  "confidence": 0.94,
  "temperature": 58.4,
  "location": { "x": 15.45, "y": 8.12 },
  "message": "순찰 로봇(orinka_01)이 근접 교차검증으로 화재를 확정했습니다.",
  "timestamp": "2026-07-18T19:40:03Z"
}
```
* `source` 값: `ROBOT` (과열 경보 등 향후 확장 시 값 추가)

#### 3) 듀얼 카메라 영상 프레임 구독 (`SUB /topic/video/{robotId}`)
* **설명**: 로봇이 WSS로 전송한 RGB(FRONT)·열화상(THERMAL) JPEG 프레임을 백엔드가 실시간 중계합니다. 대시보드는 `channel`로 두 스트림을 구분하여 나란히 렌더링합니다.
* **Payload**:
```json
{
  "robotId": "orinka_01",
  "channel": "THERMAL",
  "format": "jpeg",
  "data": "<base64-encoded JPEG>",
  "maxTemp": 36.1,
  "seq": 1024,
  "timestamp": "2026-07-18T19:40:05Z"
}
```
* `channel` 값: `FRONT`(RGB·YOLO 오버레이) 또는 `THERMAL`(열화상, `maxTemp` 포함)

#### 4) 2D 도면 매핑 점유 격자 구독 (`SUB /topic/map`) *(미확정/Deferred)*
* **설명**: ⚠️ 현재 로봇 명령 계약에는 `SAVE_MAP`(맵 저장)만 있고 맵 상향 스트리밍은 없다. 로봇의 맵 스트리밍 능력이 확인되면 백엔드가 아래 형태의 점유 격자를 `/topic/map` 으로 중계하여 대시보드(Three.js)가 렌더링한다. (능력 확인 전까지 미확정)
* **Payload**:
```json
{
  "robotId": "orinka_01",
  "resolution": 0.05,
  "width": 200,
  "height": 200,
  "origin": { "x": -5.0, "y": -5.0 },
  "data": [-1, 0, 0, 100],
  "timestamp": "2026-07-18T19:40:05Z"
}
```
* `data`: row-major 점유 배열 — `-1`(미탐색), `0`(자유공간), `100`(점유/장애물)

#### 5) 로봇 제어 발행 (`PUB /app/control/*`)
* **설명**: 웹 관제 화면의 제어 조작을 백엔드로 발행하면, 백엔드가 payload를 검증(`validate`)한 뒤 대상 로봇 WSS 세션으로 명령을 중계합니다. `robot_id`는 payload에 포함하며 생략 시 기본값 `orinka_01`을 사용합니다. 명령 어휘는 로봇 계약([3.2](#32-spring-boot-rightarrow-로봇-downstream))을 그대로 따릅니다.

| 목적지 | command | Payload 예시 |
| :--- | :--- | :--- |
| `/app/control/drive` | `DRIVE` | `{"robot_id":"orinka_01","command":"DRIVE","linear":0.5,"angular":-0.2}` |
| `/app/control/mode` | `SET_MODE` / `ESTOP` | `{"robot_id":"orinka_01","command":"SET_MODE","mode":"autonomy"}` |
| `/app/control/operation` *(후속)* | `SAVE_MAP` / `NAVIGATE` | `{"robot_id":"orinka_01","command":"SAVE_MAP","name":"factory_01"}` |

* `DRIVE`: `linear`(전진/후진 m/s), `angular`(회전 rad/s). 정지 시 둘 다 `0.0`. `manual` 모드에서 유효.
* `SET_MODE mode`: `autonomy`(자율 순찰) / `manual`(수동 조종) / `disabled`(정지). **순찰 복귀 = `SET_MODE autonomy`**.
* `ESTOP`: 활성화만 허용(fail-safe, 항상 `active=true`로 중계).

---

## 3. 로봇 ↔ Spring Boot WebSocket Secure (WSS) 통신 명세

AWS 인프라 보안 및 방화벽 규정을 준수하기 위해 Nginx 리버스 프록시(HTTPS 443 포트)를 거쳐 수립되는 로봇(Client)과 Spring Boot 메인 서버(Server) 간의 WSS 프로토콜입니다. 데이터는 WebSocket Text Frame 형태의 JSON 객체로 실시간 송수신합니다.

* **Nginx 리버스 프록시 진입 엔드포인트**: `wss://<domain>/ws/robot` (내부적으로 Spring Boot `:8080/ws/robot`으로 포워딩)

### 3.1 로봇 $\rightarrow$ Spring Boot (Upstream)

#### 1) 주기적 텔레메트리 패킷
```json
{"source": "robot", "type": "TELEMETRY", "robot_id": "orinka_01", "location": {"x": 1.25, "y": 3.40, "yaw": 0.78}, "battery": 71.0, "status": "AUTO_PATROL", "speed": 0.6, "estop": "RELEASED", "commLatencyMs": 43, "inferenceFps": 8.0, "ambientTemp": 24.8, "humidity": 39.0}
```
* `status`(로봇 보고 상위 FSM 상태): `AUTO_PATROL`, `APPROACH`, `VERIFY`, `MANUAL_CONTROL`, `MAPPING`(후속) — ⚠️ 제어 명령 `mode`(`autonomy`/`manual`/`disabled`)와는 별개 축이며, 정확한 status 문자열은 로봇 상향 텔레메트리 구현과 함께 확정
* 확장 필드: `speed`, `estop`, `commLatencyMs`, `inferenceFps`, `ambientTemp`, `humidity`

#### 1-1) 듀얼 카메라 영상 프레임 패킷
* **설명**: 전방 RGB와 열화상 프레임을 JPEG→base64로 인코딩하여 각각 전송합니다. 백엔드는 STOMP `/topic/video/{robotId}`로 중계합니다. `channel`로 두 스트림을 구분하며, `THERMAL`은 `maxTemp`를 포함합니다.
```json
{"source": "robot", "type": "VIDEO_FRAME", "robot_id": "orinka_01", "channel": "FRONT", "format": "jpeg", "data": "<base64 JPEG>", "seq": 1024}
```

#### 2) 교차검증 화재 이벤트 패킷 (개행 필수)
* **설명**: 순찰 중 YOLO 화재 후보 감지 → 자율 접근(`APPROACH`) → 근접 교차검증(`VERIFY`, YOLO + 열화상)을 거쳐 **화재로 확정된 경우에만** 전송됩니다. 접근/검증 진행 단계는 `TELEMETRY`의 `status`로만 반영됩니다.
```json
{"source": "robot", "type": "EVENT_FIRE", "robot_id": "orinka_01", "confidence": 0.94, "temperature": 58.4, "location": {"x": 15.0, "y": 8.2}}
```

#### 3) 장비 과열 이벤트 패킷 (개행 필수)
```json
{"source": "robot", "type": "EVENT_OVERHEAT", "robot_id": "orinka_01", "equipment_id": "panel_01", "temperature": 53.2, "location": {"x": 8.5, "y": 3.1}}
```

#### [후속/Deferred] 4) 2D 도면 매핑 점유 격자 패킷 (`MAPPING` 모드, 개행 필수)
* **설명**: `MAPPING` 모드에서 SLAM으로 생성 중인 점유 격자를 주기적으로 스트리밍합니다. 백엔드는 이를 STOMP `/topic/map`으로 중계합니다. **MVP 이후 구현**입니다.
```json
{"source": "robot", "type": "MAP_UPDATE", "robot_id": "orinka_01", "resolution": 0.05, "width": 200, "height": 200, "origin": {"x": -5.0, "y": -5.0}, "data": [-1, 0, 0, 100]}
```

### 3.2 Spring Boot $\rightarrow$ 로봇 (Downstream)

> **로봇 명령 계약(ground truth)**: 아래는 로봇 `remote_control_protocol.py` 가 파싱하는 명령이다. BE STOMP 컨트롤러(`RobotControlStompController`)는 이 계약과 일치하도록 검증·중계한다.
> **MVP 범위**: `SET_MODE`(자율/수동 전환·순찰 복귀), `DRIVE`(WASD) 만 관제 UI에 연결한다.

#### [MVP] 1) 모드 설정 패킷 (개행 필수)
```json
{"command": "SET_MODE", "mode": "manual"}
```
* `mode` 값: `autonomy`(자율 순찰) / `manual`(수동 조종) / `disabled`(정지). **순찰 복귀 = `SET_MODE mode=autonomy`** (별도 RESUME 명령 없음)

#### [MVP] 2) 수동 조종 방향 패킷 (개행 필수)
```json
{"command": "DRIVE", "linear": 0.5, "angular": -0.2}
```
* `linear`: 전진/후진 속도 (m/s), `angular`: 회전 각속도 (rad/s). 로봇이 `max_linear`/`max_angular`로 클램핑. `manual` 모드에서 유효.

#### [후속/Deferred] 3) 그 외 로봇 지원 명령 (개행 필수)
* 로봇 프로토콜에 정의되어 있으나 관제 UI 연결은 MVP 이후.

| command | 페이로드 | 설명 |
| :--- | :--- | :--- |
| `ESTOP` | `{"command": "ESTOP", "active": true}` | 긴급 정지 (활성화만 허용, fail-safe) |
| `NAVIGATE` | `{"command": "NAVIGATE", "x": 15.0, "y": 8.2, "yaw": 0.0}` | 지정 좌표 이동 (프로토타입 "지점 이동") |
| `SAVE_MAP` | `{"command": "SAVE_MAP", "name": "factory_01"}` | 현재 SLAM 맵 저장 (safe basename) |

* 프로토타입 UI의 전조등·경고 방송·볼륨은 현재 로봇 프로토콜 미지원 → 로봇 펌웨어 확장 후 정의.

---

## 4. [고도화 단계] Gateway (FastAPI) ↔ Spring Boot 연동 명세 (선택사항)

MVP 개발 완료 이후, 비디오 스트리밍 분산 처리 및 포트폴리오 다각화를 위해 **2단계 게이트웨이 아키텍처**로 확장할 경우 사용되는 백엔드 간 연동 규격입니다. (1단계 개발 시에는 생략됩니다.)

* **WebSocket 연결 엔드포인트**: `ws://localhost:8080/ws-gateway`

### 4.1 게이트웨이 $\rightarrow$ 메인 서버 데이터 전송 (Pub)
* `PUB /app/gateway/telemetry`: 로봇 실시간 텔레메트리 갱신
* `PUB /app/gateway/event`: 실시간 화재/과열 이벤트 릴레이

### 4.2 메인 서버 $\rightarrow$ 게이트웨이 명령 전송 (Sub)
* `SUB /topic/gateway/commands`: 웹 대시보드에서 수동으로 내린 제어 명령을 게이트웨이로 전달

