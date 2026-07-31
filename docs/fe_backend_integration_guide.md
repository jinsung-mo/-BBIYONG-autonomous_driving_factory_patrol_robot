# 삐용 (BBIYONG) — FE ↔ 백엔드 실시간 연동 가이드

프론트엔드(React 관제 대시보드)가 백엔드 실서버에 **STOMP/REST로 붙기 위한 단일 참조 문서**입니다.
계약(payload/토픽)의 원본 정의는 [`architecture_and_api_spec.md` §2.3](./architecture_and_api_spec.md#23-실시간-웹소켓websocket-토픽-구조-spring-boot-leftrightarrow-web-client) 및
[`backend_api_specification.md` §1·§2](./backend_api_specification.md) 이며, 이 문서는 그 위에 **실서버 접속 정보·구현 매핑·현재 상태**를 더한 실무 가이드입니다.

---

## 0. 현재 상태 (중요)

| 구간 | 상태 | 비고 |
| :-- | :-- | :-- |
| BE 제어 중계 (STOMP `/app/control/*` → 로봇 WSS) | ✅ 배포·**라이브 검증 완료** | DRIVE/SET_MODE/ESTOP/NAVIGATE 4종 실측 |
| BE 상행 브로드캐스트 (로봇 WSS → `/topic/robots`·`/topic/video`) | ✅ 배포·**라이브 검증 완료** | 텔레메트리·영상 프레임 실측 |
| BE 경보 (`/topic/alerts`, `AlertMessage`) | ✅ 배포 (유닛테스트 통과) | |
| **BE STOMP 인증 (CONNECT JWT 검증)** | 🔜 **병합·배포 후 적용** | 무인증 → **JWT 필수**로 전환 (S15P11E101-418). FE는 지금부터 토큰을 실어 구현할 것 |
| **BE 2D 맵 API (`/api/maps`)** | 🔜 **병합·배포 후 적용** | SLAM 맵 이미지 저장·서빙 (S15P11E101-426). 실시간 `/topic/map`은 Deferred → 우선 REST 제공. FE 렌더는 §8 |
| **BE 온디맨드 매핑 (START/STOP_MAPPING·완료·활성맵)** | 🔜 **병합 대기** | 맵 모델링 시작/중단 중계 + `/topic/mapping` 완료 relay + 활성 맵 API (S15P11E101-495·482). §3.4·§4·§8.6 |
| **BE 설비 임계값 로봇 반영** | 🔜 **병합 대기** | `PUT /api/equipments/{id}` 수정 시 로봇으로 `SET_THRESHOLD` 중계(실제 판정 반영). (S15P11E101-499) |
| **BE 로봇 연결상태 정확화** | 🔜 **병합 대기** | `GET /api/robots`의 `online`/`status(OFFLINE)` 정확화 + 끊김 시 `/topic/robots` offline 브로드캐스트 (S15P11E101-500). FE는 `online`/offline 메시지로 live 판정할 것 |
| **FE 연동** | ❌ **미연동** | 현재 관제 화면(예: `EventAlert.jsx`)은 로컬 시뮬레이션(`useSim`)으로만 동작 |

> 즉 **백엔드는 준비 완료**, FE에서 (인증 포함) 구독/발행만 붙이면 됩니다.

---

## 1. 접속 정보

| 항목 | 값 |
| :-- | :-- |
| REST Base | `https://i15e101.p.ssafy.io` |
| STOMP 엔드포인트 | `wss://i15e101.p.ssafy.io/ws/control` (한글 경로 `/ws-관제`의 ASCII 별칭, SockJS도 지원) |
| STOMP app prefix | `/app` (발행) |
| STOMP broker prefix | `/topic` (구독) |
| 로컬 개발 | `npm run dev` → 위 배포 wss로 붙이거나, 로컬 백엔드면 `ws://localhost:8080/ws-관제` |

**인증 정책**
- **STOMP 계층도 JWT 필수** (S15P11E101-418) — **CONNECT 프레임에 `Authorization: Bearer <accessToken>` 헤더**를 실어야 연결·구독·발행이 가능. 토큰이 없거나 무효면 서버가 연결을 거부(ERROR 프레임)한다.
- **REST(`/api/**`)도 JWT 필수** — `Authorization: Bearer <accessToken>`.
- 먼저 §2 로그인으로 `accessToken`을 확보한 뒤, **STOMP CONNECT·REST 호출 양쪽에 동일 토큰**을 사용한다.
- 로봇 원시 WSS(`/ws/robot`)는 로봇↔서버 전용 별도 채널로 본 인증과 무관.
- 배포 반영 시점: 위 인증은 -418 병합·배포 후 강제된다. **FE는 지금부터 토큰을 실어 구현**하면 되며, 아직 미적용인 서버에서도 토큰을 실어 보내는 것은 무시되어 정상 동작한다.

**라이브러리 권장**: `@stomp/stompjs` (필요 시 `sockjs-client`).

```js
import { Client } from '@stomp/stompjs'

// 1) 먼저 §2 로그인으로 accessToken 확보
const client = new Client({
  brokerURL: 'wss://i15e101.p.ssafy.io/ws/control',
  connectHeaders: { Authorization: 'Bearer ' + accessToken }, // ← CONNECT 인증 필수
  reconnectDelay: 2000,
  onConnect: () => {
    // 아래 3.구독 참고
  },
  onStompError: (frame) => {
    // 토큰 누락/만료 시 서버가 ERROR 프레임으로 연결 거부
    console.error('STOMP 연결 거부(인증 확인 필요):', frame.headers['message'])
  },
})
client.activate()
```

---

## 2. 로그인 (REST · JWT)

```
POST https://i15e101.p.ssafy.io/api/auth/signup   # 최초 1회 (public)
  body: {"email":"you@bbiyong.io","password":"pass1234!","name":"관리자"}

POST https://i15e101.p.ssafy.io/api/auth/login     # (public)
  body: {"email":"you@bbiyong.io","password":"pass1234!"}
  → {"tokenType":"Bearer","accessToken":"<JWT>","expiresIn":86400,"role":"ROLE_ADMIN"}
```
이후 **조회 API 호출 시 헤더**에, 그리고 **STOMP CONNECT 헤더**(§1)에 `Authorization: Bearer <accessToken>` 필요.
조회 API: `GET /api/robots`, `GET /api/equipments`, `GET /api/events`, `GET /api/videos`.

---

## 3. 구독 (SUB, `/topic`) — 받아서 화면에 반영

```js
client.subscribe('/topic/robots', (m) => onTelemetry(JSON.parse(m.body)))
client.subscribe('/topic/alerts', (m) => onAlert(JSON.parse(m.body)))
client.subscribe('/topic/video/orinka_01', (m) => onVideo(JSON.parse(m.body)))
```

### 3.1 `/topic/robots` — 실시간 텔레메트리 (StatusPanel·지도)
```json
{
  "robot_id": "orinka_01",
  "status": "AUTO_PATROL",
  "battery": 63.5,
  "speed": 0.7,
  "estop": "RELEASED",
  "commLatencyMs": 27,
  "inferenceFps": 9.5,
  "location": { "x": 9.9, "y": 4.4, "yaw": 1.0 }
}
```
- `status`: `AUTO_PATROL` / `APPROACH` / `VERIFY` / `MANUAL_CONTROL` / `MAPPING`(후속)
- 온습도(주변 온도·습도)는 센서 미사용 → 텔레메트리에 없음.

### 3.2 `/topic/alerts` — 화재/과열 경보 (EventAlert 토스트)
표준 `AlertMessage`. 로봇이 **확정**한 경보만 1회 발행(진행 단계는 `/topic/robots` 상태로만 반영).

```json
// FIRE
{ "type":"FIRE", "level":"CRITICAL", "source":"ROBOT", "robotId":"orinka_01",
  "confidence":0.94, "temperature":58.4, "equipmentId":null, "threshold":null, "thermalImage":null,
  "x":15.45, "y":8.12, "message":"순찰 로봇(orinka_01)이 근접 교차검증으로 화재를 확정했습니다.",
  "timestamp":"2026-07-27T10:53:00Z" }

// OVERHEAT (equipmentId/threshold/thermalImage 포함, 열화상은 중계만·미저장)
{ "type":"OVERHEAT", "level":"WARNING", "source":"ROBOT", "robotId":"orinka_01",
  "confidence":null, "temperature":63.2, "equipmentId":"panel_A", "threshold":55.0, "thermalImage":"<base64 jpeg>",
  "x":8.5, "y":3.1, "message":"설비(panel_A) 과열이 감지되었습니다.",
  "timestamp":"2026-07-27T10:53:00Z" }
```
- `type`: `FIRE`|`OVERHEAT` · `level`: `CRITICAL`(화재)|`WARNING`(과열) · `source`: `ROBOT`

### 3.3 `/topic/video/{robotId}` — 듀얼 카메라 프레임
```json
{ "robotId":"orinka_01", "channel":"THERMAL", "format":"jpeg",
  "data":"<base64 JPEG>", "maxTemp":36.1, "seq":1024, "timestamp":"..." }
```
- `channel`: `FRONT`(RGB·YOLO 오버레이) | `THERMAL`(열화상, `maxTemp` 포함)

### 3.4 `/topic/mapping` — 온디맨드 매핑 완료 알림 (S15P11E101-482)
맵 모델링(자율탐색)을 §4 `START_MAPPING`으로 시작한 뒤, 로봇이 매핑을 끝내면 서버가 `EVENT_MAPPING_COMPLETE` 원문을 이 토픽으로 relay 한다. FE는 "완료" 알림 표시 후 §8.6 활성 맵 지정/`GET /api/maps/latest`로 새 도면을 불러온다.
```js
client.subscribe('/topic/mapping', (m) => onMappingComplete(JSON.parse(m.body)))
// 예: { "type":"EVENT_MAPPING_COMPLETE", "robot_id":"orinka_01", "name":"factory_01" }
```

### 3.5 `/topic/nav/{robotId}` — 실시간 맵/자세 (있을 때)
로봇이 `MAP`(2D 점유격자 RLE)·`NAV_LIVE`(pose·scan)를 보내면 서버가 원문 그대로 중계한다. 지원 여부는 로봇 구현에 따른다.
```js
client.subscribe('/topic/nav/orinka_01', (m) => onNav(JSON.parse(m.body)))
```

---

## 4. 발행 (PUB, `/app/control/*`) — 버튼 → 로봇 제어

백엔드가 payload를 검증 후 로봇 WSS 명령으로 중계한다. `robot_id`는 payload에 포함(기본 `orinka_01`).

| 목적지 | UI 버튼 | payload |
| :-- | :-- | :-- |
| `/app/control/drive` | WASD 이동 | `{"robot_id":"orinka_01","command":"DRIVE","linear":0.5,"angular":-0.1}` |
| `/app/control/mode` | 순찰/수동 모드 | `{"robot_id":"orinka_01","command":"SET_MODE","mode":"autonomy"}` |
| `/app/control/mode` | 긴급 정지 | `{"robot_id":"orinka_01","command":"ESTOP","active":true}` |
| `/app/control/operation` | 지점 이동 | `{"robot_id":"orinka_01","command":"NAVIGATE","x":15.0,"y":8.2,"yaw":0.0}` |
| `/app/control/operation` | 맵 모델링 시작 | `{"robot_id":"orinka_01","command":"START_MAPPING"}` |
| `/app/control/operation` | 맵 모델링 중단 | `{"robot_id":"orinka_01","command":"STOP_MAPPING"}` |
| `/app/control/operation` | 맵 저장 | `{"robot_id":"orinka_01","command":"SAVE_MAP","name":"factory_01"}` |

```js
const publish = (dest, body) =>
  client.publish({ destination: dest, body: JSON.stringify({ robot_id: 'orinka_01', ...body }) })

publish('/app/control/drive', { command: 'DRIVE', linear: 0.5, angular: -0.1 })
publish('/app/control/mode',  { command: 'SET_MODE', mode: 'autonomy' })
publish('/app/control/mode',  { command: 'ESTOP', active: true })
publish('/app/control/operation', { command: 'NAVIGATE', x: 15.0, y: 8.2, yaw: 0.0 })
```

**WASD → 선속도/각속도 매핑(예시, 로봇이 max로 클램핑)**

| 키 | linear | angular |
| :-: | :-: | :-: |
| `w` (전진) | `+0.5` | `0` |
| `s` (후진) | `-0.5` | `0` |
| `a` (좌회전) | `0` | `+0.5` |
| `d` (우회전) | `0` | `-0.5` |
| 정지 | `0` | `0` |

**규칙/주의**
- 순찰 복귀 = 별도 명령 아님 → `SET_MODE mode=autonomy` (로봇 프로토콜에 `RESUME` 없음).
- `mode`는 `autonomy` / `manual` / `disabled` 만 유효. `DRIVE`는 `manual` 모드에서 유효.
- `ESTOP`은 fail-safe: `active:true` 만 허용(해제 명령 없음).
- 서버 경보는 **일회성(one-shot)** — 대응하는 "해제" 이벤트가 없음.

---

## 5. 로봇 프로토콜 미지원 (연동 대상 아님)

프로토타입 UI의 **전조등 · 경고 방송 · 볼륨**은 현재 로봇 명령 계약에 없음 → 백엔드로 보내도 중계 대상이 아님. UI 로컬 처리만 하거나 비활성 처리 권장(펌웨어 확장 후 정의 예정).

---

## 6. 기존 FE 코드 연동 포인트

현재 관제 화면은 로컬 시뮬레이션(`useSim`/`SimContext`)으로 동작한다. **mock↔real 전환 플래그**를 두어 시뮬레이션 데모를 보존하면서 실서버 모드를 추가하는 것을 권장한다.

- **`EventAlert.jsx`**: 지금은 `status.fireOn`/`heatOn`(시뮬) 전이로 토스트 생성. → `/topic/alerts` 구독 결과로 `pushAlert()`를 호출하도록 트리거 교체.
  - `type==="FIRE"` → `pushAlert('fire', '🔥 화재 발생', '🤖 ' + robotId + ' 긴급 출동 중')`
  - `type==="OVERHEAT"` → `pushAlert('heat', '⚠ 분전반 과열 의심', equipmentId + ' · ' + temperature + '℃')`
  - 서버 경보는 one-shot이므로 ✕ 닫기는 시뮬 토글이 아니라 토스트만 닫도록 조정.
- **StatusPanel / MapPanel**: 시뮬 값 대신 `/topic/robots` 수신값(위치·배터리·속도·estop·FPS)으로 표시.
- **ControlPanel**: 버튼 클릭 시 §4의 `/app/control/*` 발행 추가.
- **인증**: 실서버 모드는 §2 로그인으로 JWT 확보 후, **STOMP CONNECT(§1)와 REST 조회 양쪽에** 헤더 첨부. 토큰 없이는 STOMP 연결 자체가 거부된다.

---

## 7. 검증 상태 (참고)

배포 서버(`i15e101.p.ssafy.io`)에서 다음을 실측 확인함:
- 제어 하행 4/4: STOMP `/app/control/*` → 로봇 WSS 정확 전달(SET_MODE·DRIVE·ESTOP·NAVIGATE).
- 상행 브로드캐스트: 로봇 WSS `STATE_UPDATE`/`VIDEO_FRAME` → `/topic/robots`·`/topic/video/{id}` 정상 수신.

즉 FE가 이 문서대로 붙이면 별도 백엔드 변경 없이 동작한다.

---

## 8. 2D 맵 렌더링 (REST · `/api/maps`)

2D 도면은 로봇 SLAM 맵이다. **실시간 점유격자 스트리밍(`/topic/map`)은 로봇의 맵 상향 스트리밍 능력이 미확정이라 Deferred**이며, 그 전까지 **REST로 최신 맵 이미지 + 좌표 메타를 제공**한다. FE는 이 이미지를 받아 2D 맵 패널에 그리고, `resolution`·`origin`으로 로봇 좌표와 정렬한다. (S15P11E101-426)

### 8.1 엔드포인트
| 메서드/경로 | 용도 |
| :-- | :-- |
| `GET /api/maps/latest?robotId=orinka_01` | **대시보드가 현재 도면을 그릴 때** 쓰는 최신 맵(메타 + imageUrl) |
| `GET /api/maps/{id}/image` | 맵 이미지 바이트 서빙 (PNG 등) |
| `GET /api/maps` | 맵 목록(최신순 Summary, 각 항목 `active` 포함) |
| `GET /api/maps/active` | **현재 활성 맵**(운영 도면). 없으면 404 |
| `PUT /api/maps/{id}/active` | 저장된 맵을 **활성 맵으로 지정**(온디맨드 매핑 완료 후 "이 맵 사용", 단일 활성) |
| `POST /api/maps/upload` *(FE 아님)* | 로봇/게이트웨이가 `SAVE_MAP` 산출물(이미지+메타) 등록 |

### 8.2 `GET /api/maps/latest` 응답
```json
{
  "id": "57d4fa92-...",
  "name": "factory_01",
  "robotId": "orinka_01",
  "imageUrl": "/api/maps/57d4fa92-.../image",
  "widthPx": 400,
  "heightPx": 300,
  "resolution": 0.05,
  "originX": -10.0,
  "originY": -7.5,
  "originYaw": 0.0,
  "fileSizeBytes": 1910,
  "createdAt": "2026-07-28T03:29:49Z"
}
```
- `resolution`: 미터/픽셀 (m/px)
- `originX`/`originY`/`originYaw`: 맵 원점의 월드 좌표(ROS map 규약: 이미지 좌하단이 원점, 위로 갈수록 +y)

### 8.3 FE 사용 (인증 필요 → blob-fetch)
`/api/maps/{id}/image`도 JWT 인가 대상이라 `<img src>`로는 헤더를 못 싣는다. **fetch로 blob을 받아** `URL.createObjectURL`로 렌더한다.
```js
// 1) 최신 맵 메타 (authed)
const map = await authedGet('/api/maps/latest?robotId=orinka_01', accessToken)

// 2) 이미지는 blob-fetch
const blob = await fetch(REST_BASE + map.imageUrl, {
  headers: { Authorization: 'Bearer ' + accessToken },
}).then((r) => r.blob())
const src = URL.createObjectURL(blob) // <img src={src}> 또는 canvas 배경
```

### 8.4 로봇 좌표 ↔ 맵 픽셀 정렬
텔레메트리 위치(`/topic/robots`의 `location.x/y`, 미터)를 맵 이미지 위에 겹칠 때:
```js
// 월드(m) → 이미지 픽셀 (y축은 이미지가 아래로 증가하므로 뒤집는다)
const px = (worldX - map.originX) / map.resolution
const py = map.heightPx - (worldY - map.originY) / map.resolution
```
- 이 변환으로 로봇 마커·경보 위치(`AlertMessage.x/y`)·NAVIGATE 목표를 실제 도면 위 정확한 지점에 표시할 수 있다.
- 그동안 좌표 매핑을 임시 1:1로 두었다면, 위 `resolution`/`origin` 값으로 대체하면 맵·지점이동이 함께 정확해진다.

### 8.6 온디맨드 매핑 → 활성 맵 흐름 (S15P11E101-482)
1. FE가 §4 `START_MAPPING` 발행 → 로봇이 자율탐색 매핑 시작.
2. 로봇 매핑 완료 → 서버가 §3.4 `/topic/mapping`으로 완료 알림 relay.
3. FE는 `GET /api/maps`(또는 `latest`)로 새 맵을 확인하고, **`PUT /api/maps/{id}/active`로 활성 맵 지정**("이 맵 사용").
4. 이후 대시보드는 `GET /api/maps/active`로 운영 도면을 로드(§8.3 blob-fetch 동일).

> 활성 맵은 **단일**이다. 새로 지정하면 기존 활성은 자동 해제된다. `Summary`/`Detail`의 `active`(boolean)로 현재 활성 여부를 알 수 있다.

### 8.7 상태
- `-426`(저장·서빙)·`-482`(활성 맵) **병합·배포 후** 사용 가능. 그 전엔 404. 업로더(로봇/게이트웨이)가 `SAVE_MAP` 후 `POST /api/maps/upload`를 호출해야 맵이 채워진다.

---

## 참조
- [architecture_and_api_spec.md §2.3 — 웹소켓 토픽 구조](./architecture_and_api_spec.md#23-실시간-웹소켓websocket-토픽-구조-spring-boot-leftrightarrow-web-client)
- [backend_api_specification.md §1 REST · §2 STOMP](./backend_api_specification.md)
