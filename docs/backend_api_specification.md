# 삐용 (BBIYONG) 백엔드 API 명세

Spring Boot 백엔드는 REST API, STOMP WebSocket, 로봇 WSS 연결을 제공합니다. 배포 Compose 환경에서 이벤트·설비·영상 메타데이터는 MySQL에 저장하며, 영상과 열화상 원본은 DB에 저장하지 않습니다.

---

## 1. REST API

인증과 조회는 REST API로 처리합니다. 모든 요청과 응답은 JSON 형식이며, 인증이 필요한 요청에는 `Authorization: Bearer <JWT>` 헤더를 포함합니다.

| Method | Path | 설명 |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | 관리자 계정 생성 |
| `POST` | `/api/auth/login` | 로그인 및 JWT 발급 |
| `GET` | `/api/robots` | 로봇 상태 요약 조회 |
| `GET` | `/api/equipments` | 설비와 최근 점검 상태 조회 |
| `PUT` | `/api/equipments/{equipmentId}` | 설비 임계 온도 수정 (수정 시 로봇으로 `SET_THRESHOLD` 중계) |
| `GET` | `/api/events` | 이벤트 이력 조회 |
| `PATCH` | `/api/events/{eventId}` | 이벤트 상태 전이 (`UNRESOLVED`→`RESOLVED`) |
| `POST` | `/api/videos` · `/api/videos/upload` | 영상 메타 등록 / 파일 업로드(multipart) |
| `GET` | `/api/videos` · `/api/videos/{id}` · `/{id}/stream` · `/{id}/thumbnail` | 영상 목록/상세/스트리밍(Range)/썸네일 |
| `GET` | `/api/events/{eventId}/video` | 이벤트 연관 영상 조회 |
| `POST` | `/api/maps/upload` | 2D SLAM 맵 이미지 업로드(로봇/게이트웨이) |
| `GET` | `/api/maps` · `/api/maps/latest` · `/api/maps/{id}` · `/{id}/image` | 맵 목록/최신/상세/이미지 서빙 |
| `GET/PUT` | `/api/maps/active` · `/api/maps/{id}/active` | 활성 맵 조회 / 지정(단일 활성) |
| `DELETE` | `/api/events/{eventId}` | 이벤트(경보) 삭제 — 테스트/더미 정리(없으면 404) |
| `GET/POST/PUT/DELETE` | `/api/waypoints` · `/api/waypoints/apply` | 순찰 지점 CRUD·일괄교체 / 로봇 하달(`SET_PATROL_ROUTE`) |
| `GET/PUT` | `/api/settings/drive-speed` | 주행 속도 상한 조회/설정(→`SET_MAX_SPEED` 중계) |

### 주요 요청 예시

```json
// POST /api/auth/login
{ "email": "admin@example.com", "password": "<password>" }

// Response
{ "tokenType": "Bearer", "accessToken": "<JWT>", "role": "ROLE_ADMIN" }
```

```json
// PUT /api/equipments/panel_A
{ "threshold": 55.0 }
```

```text
GET /api/events?page=0&size=10&type=FIRE
```

`/api/events`는 `FIRE`, `OVERHEAT`, `SYSTEM` 유형을 조회할 수 있습니다. 설비 임계 온도는 화면 표시용 값이며, 실제 과열 판정은 로봇이 수행합니다.

### 영상 메타데이터

`POST /api/videos`는 업로드가 끝난 영상의 메타데이터를 등록합니다. `filePath`와 `thumbnailPath`에는 파일 경로 또는 저장소 키를 저장하며, 원본 영상 데이터는 MySQL에 저장하지 않습니다.

```json
{
  "robotId": "orinka_01",
  "eventId": 1,
  "clipType": "EVENT",
  "filePath": "/data/videos/orinka_01/event_1.mp4",
  "thumbnailPath": "/data/videos/orinka_01/event_1.jpg"
}
```

---

## 2. 웹 관제 STOMP

웹 관제는 Nginx를 통해 `wss://<domain>/ws-관제`에 연결합니다. 앱 prefix는 `/app`, 구독 prefix는 `/topic`입니다.

| 구분 | Destination | 내용 |
| --- | --- | --- |
| 구독 | `/topic/robots` | 위치, 상태, 배터리 등 로봇 텔레메트리 (끊김 시 `status:OFFLINE` 브로드캐스트) |
| 구독 | `/topic/alerts` | 화재·과열 경보 |
| 구독 | `/topic/video/{robotId}` | RGB 또는 열화상 JPEG 프레임 |
| 구독 | `/topic/mapping` | 온디맨드 매핑 완료(`EVENT_MAPPING_COMPLETE`) relay |
| 구독 | `/topic/nav/{robotId}` | `MAP`(점유격자)·`NAV_LIVE`(pose·scan) 원문 중계 |
| 발행 | `/app/control/drive` | 수동 주행 `DRIVE` 명령 |
| 발행 | `/app/control/mode` | 모드 전환 `SET_MODE` / `ESTOP` |
| 발행 | `/app/control/operation` | `START_MAPPING` / `STOP_MAPPING` / `NAVIGATE` / `SAVE_MAP` |

### 제어 메시지

```json
// /app/control/drive
{ "robot_id": "orinka_01", "command": "DRIVE", "linear": 0.5, "angular": -0.2 }

// /app/control/mode
{ "robot_id": "orinka_01", "command": "SET_MODE", "mode": "autonomy" }
```

`DRIVE`는 `manual` 모드에서만 유효합니다. 순찰 복귀는 `SET_MODE`의 `autonomy` 모드로 처리합니다.

---

## 3. 로봇 WSS 통신

로봇은 `wss://<domain>/ws/robot`으로 JSON 메시지를 전송하고, Spring Boot는 검증한 제어 명령을 같은 연결로 전달합니다.

### 로봇 → 서버

| Type | 용도 | 주요 필드 |
| --- | --- | --- |
| `REGISTER` | 로봇 연결 등록 | `robot_id` |
| `TELEMETRY` | 상태 주기 전송 | `robot_id`, `location`, `battery`, `status` |
| `MAP` | 2D 점유 격자 전송 | `resolution`, `width`, `height`, `data` |
| `NAV_LIVE` | 실시간 자세·스캔 전송 | `pose`, `scan` |
| `VIDEO_FRAME` | RGB·열화상 프레임 전송 | `channel`, `data`, `maxTemp` |
| `EVENT_FIRE` | 화재 확정 경보 | `confidence`, `temperature`, `location` |
| `EVENT_OVERHEAT` | 설비 과열 경보 | `equipment_id`, `temperature`, `threshold`, `thermalImage` |
| `INSPECTION` | 분전반 정상 점검 리포트 | `equipment_id`, `temperature` |
| `EVENT_MAPPING_COMPLETE` | 온디맨드 매핑 완료 → `/topic/mapping` relay | `robot_id`, `name` |

```json
{
  "source": "robot",
  "type": "EVENT_FIRE",
  "robot_id": "orinka_01",
  "confidence": 0.94,
  "temperature": 58.4,
  "location": { "x": 15.0, "y": 8.2 }
}
```

화재 경보는 YOLO와 열화상 교차검증이 완료된 경우에만 전송합니다. 백엔드는 이벤트 이력을 MySQL에 저장하고 `/topic/alerts`로 중계합니다.

### 서버 → 로봇

| Command | Payload | 설명 |
| --- | --- | --- |
| `SET_MODE` | `{ "command": "SET_MODE", "mode": "manual" }` | `autonomy`, `manual`, `disabled` 모드 전환 |
| `DRIVE` | `{ "command": "DRIVE", "linear": 0.5, "angular": -0.2 }` | 수동 주행 (`manual` 모드) |
| `ESTOP` | `{ "command": "ESTOP", "active": true }` | 긴급 정지 (활성화만, fail-safe) |
| `NAVIGATE` | `{ "command": "NAVIGATE", "x": 15.0, "y": 8.2, "yaw": 0.0 }` | 지정 좌표 이동 |
| `START_MAPPING` / `STOP_MAPPING` | `{ "command": "START_MAPPING" }` | 자율탐색 맵 모델링 시작/중단 |
| `SAVE_MAP` | `{ "command": "SAVE_MAP", "name": "factory_01" }` | 현재 SLAM 맵 저장 |
| `SET_THRESHOLD` | `{ "command": "SET_THRESHOLD", "equipmentId": "panel_A", "threshold": 55.0 }` | 설비 과열 임계값 반영 |
| `SET_PATROL_ROUTE` | `{ "command": "SET_PATROL_ROUTE", "waypoints": [{"seq":0,"x":8.5,"y":3.1,"yaw":0.0}] }` | 순찰 경로(waypoint 배열) 하달 |
| `SET_MAX_SPEED` | `{ "command": "SET_MAX_SPEED", "maxLinear": 0.5, "maxAngular": 0.5 }` | 주행 속도 상한 반영 |
