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
| **FE 연동** | ❌ **미연동** | 현재 관제 화면(예: `EventAlert.jsx`)은 로컬 시뮬레이션(`useSim`)으로만 동작 |

> 즉 **백엔드는 준비 완료**, FE에서 구독/발행만 붙이면 됩니다.

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
- **STOMP 계층은 현재 인증 불필요** — 그냥 CONNECT 하면 구독/발행 가능.
- **REST(`/api/**`)는 JWT 필수** — 로그인 후 `Authorization: Bearer <accessToken>`.
- (후속) STOMP에도 인증을 붙이려면 CONNECT 헤더에 토큰을 싣는 방식으로 확장 예정.

**라이브러리 권장**: `@stomp/stompjs` (필요 시 `sockjs-client`).

```js
import { Client } from '@stomp/stompjs'

const client = new Client({
  brokerURL: 'wss://i15e101.p.ssafy.io/ws/control',
  reconnectDelay: 2000,
  onConnect: () => {
    // 아래 3.구독 참고
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
이후 조회 API 호출 시 헤더에 `Authorization: Bearer <accessToken>` 필요.
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
- `/topic/map` *(미확정/후속)*: 로봇 맵 스트리밍 능력 확인 시 점유 격자 중계.

---

## 4. 발행 (PUB, `/app/control/*`) — 버튼 → 로봇 제어

백엔드가 payload를 검증 후 로봇 WSS 명령으로 중계한다. `robot_id`는 payload에 포함(기본 `orinka_01`).

| 목적지 | UI 버튼 | payload |
| :-- | :-- | :-- |
| `/app/control/drive` | WASD 이동 | `{"robot_id":"orinka_01","command":"DRIVE","linear":0.5,"angular":-0.1}` |
| `/app/control/mode` | 순찰/수동 모드 | `{"robot_id":"orinka_01","command":"SET_MODE","mode":"autonomy"}` |
| `/app/control/mode` | 긴급 정지 | `{"robot_id":"orinka_01","command":"ESTOP","active":true}` |
| `/app/control/operation` | 지점 이동 | `{"robot_id":"orinka_01","command":"NAVIGATE","x":15.0,"y":8.2,"yaw":0.0}` |
| `/app/control/operation` *(후속)* | 맵 저장 | `{"robot_id":"orinka_01","command":"SAVE_MAP","name":"factory_01"}` |

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
- **인증**: 실서버 모드에서 REST 조회가 필요하면 §2 로그인으로 JWT 확보 후 헤더 첨부.

---

## 7. 검증 상태 (참고)

배포 서버(`i15e101.p.ssafy.io`)에서 다음을 실측 확인함:
- 제어 하행 4/4: STOMP `/app/control/*` → 로봇 WSS 정확 전달(SET_MODE·DRIVE·ESTOP·NAVIGATE).
- 상행 브로드캐스트: 로봇 WSS `STATE_UPDATE`/`VIDEO_FRAME` → `/topic/robots`·`/topic/video/{id}` 정상 수신.

즉 FE가 이 문서대로 붙이면 별도 백엔드 변경 없이 동작한다.

---

## 참조
- [architecture_and_api_spec.md §2.3 — 웹소켓 토픽 구조](./architecture_and_api_spec.md#23-실시간-웹소켓websocket-토픽-구조-spring-boot-leftrightarrow-web-client)
- [backend_api_specification.md §1 REST · §2 STOMP](./backend_api_specification.md)
