// @ts-check
// 실서버 연동 설정 — docs/fe_backend_integration_guide.md §1 접속 정보 기준.
//
// 값은 Vite 환경변수로 덮어쓸 수 있고, 없으면 배포 서버 기본값을 쓴다.
// (Vite는 `.env.dev`를 기본 로드하지 않는다 — `--mode dev`로 실행할 때만 읽히므로
//  기본값을 코드에 두어 별도 설정 없이도 붙도록 한다.)

const env = import.meta.env

// wss 핸드셰이크(101) 확인됨 — SockJS 폴백 없이 brokerURL로 직접 연결한다.
export const WS_URL = env.VITE_WS_URL || 'wss://i15e101.p.ssafy.io/ws/control'
export const REST_BASE = env.VITE_REST_BASE_URL || 'https://i15e101.p.ssafy.io'

// 현재 편성된 순찰 로봇 1대. 제어 payload의 robot_id / 영상 토픽 경로에 쓰인다.
export const ROBOT_ID = env.VITE_ROBOT_ID || 'orinka_01'

// ---- 로봇 수동 주행 상한 (S15P11E101-463) ----
// 관제가 보내는 DRIVE 는 BE_robot/tools/diff_drive/teleop_node.py 의 V_MAX/W_MAX 로 잘린다.
// 이 값보다 큰 수를 보내면 로봇이 조용히 클램프해 슬라이더 표시와 실제 속도가 어긋난다.
//
// 선속도와 각속도의 상한이 서로 다르다는 점이 중요하다 — 하나의 배율을 양쪽에 그대로
// 곱하면 회전만 먼저 상한에 걸린다. 슬라이더 값은 선속도(m/s)로 읽고, 각속도는
// 같은 비율(speed / V_MAX)을 W_MAX 에 적용한다.
//
// 로봇 상한이 바뀌면 여기(또는 env)만 고치면 슬라이더 범위·증감·기본값이 함께 따라간다.
export const ROBOT_V_MAX = Number(env.VITE_ROBOT_V_MAX ?? 1.0)   // m/s
export const ROBOT_W_MAX = Number(env.VITE_ROBOT_W_MAX ?? 0.6)   // rad/s

// ---- 좌표 변환 (미확정 · BE/로봇 파트 확인 필요) ----
// 시뮬 지도는 12x8 격자 정수 좌표({c,r})이고, 실서버 텔레메트리는 미터 단위 실수 좌표(x,y)다.
// 실제 공장 맵의 원점과 스케일이 확정되기 전까지는 아래 기본값(원점 0,0 · 1m = 1칸)으로
// 1:1 대응시킨다. 확정되면 env로 덮어쓰거나 이 값을 고치면 지도/지점이동이 함께 맞는다.
export const MAP_ORIGIN_X = Number(env.VITE_MAP_ORIGIN_X ?? 0)
export const MAP_ORIGIN_Y = Number(env.VITE_MAP_ORIGIN_Y ?? 0)
export const MAP_METERS_PER_CELL = Number(env.VITE_MAP_METERS_PER_CELL ?? 1)

// 실서버 미터 좌표 → 시뮬 격자 좌표
export const worldToCell = (x, y) => ({
  c: (x - MAP_ORIGIN_X) / MAP_METERS_PER_CELL,
  r: (y - MAP_ORIGIN_Y) / MAP_METERS_PER_CELL,
})

// 시뮬 격자 좌표 → 실서버 미터 좌표 (NAVIGATE 발행용)
export const cellToWorld = (c, r) => ({
  x: c * MAP_METERS_PER_CELL + MAP_ORIGIN_X,
  y: r * MAP_METERS_PER_CELL + MAP_ORIGIN_Y,
})

// ---- mock | live 전환 ----
// 기본은 mock(로컬 시뮬레이션) — 설정 없이 받은 사람의 데모 동작이 바뀌지 않게 한다.
// 런타임 토글(Nav 버튼)이 localStorage에 남아 env보다 우선한다.
const SOURCE_KEY = 'bbiyong.dataSource'
// S15P11E101-510 이 지정한 이름. 기존 키를 갈아엎지 않고 별칭으로 함께 읽고 쓴다 —
// 이미 배포된 브라우저의 localStorage 와 팀이 쓰는 토글이 둘 다 살아 있어야 한다.
const REAL_KEY = 'bbiyong.realBackend'

const truthy = (v) => v === true || v === 'true' || v === '1'
const DEFAULT_SOURCE = (env.VITE_DATA_SOURCE === 'live' || truthy(env.VITE_REAL_BACKEND)) ? 'live' : 'mock'

export function getDataSource() {
  try {
    const saved = localStorage.getItem(SOURCE_KEY)
    if (saved === 'live' || saved === 'mock') return saved
    const real = localStorage.getItem(REAL_KEY)
    if (real !== null) return truthy(real) ? 'live' : 'mock'
  } catch {
    // localStorage 차단 환경 — env 기본값으로 진행
  }
  return DEFAULT_SOURCE
}

export function saveDataSource(value) {
  try {
    localStorage.setItem(SOURCE_KEY, value)
    localStorage.setItem(REAL_KEY, String(value === 'live'))
  } catch { /* 저장 실패는 무시 */ }
}
