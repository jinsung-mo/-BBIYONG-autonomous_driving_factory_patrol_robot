// 순찰 지점(waypoint) API — S15P11E101-514 · 629.
// BE 계약: PatrolRouteController (S15P11E101-520).
//
//   GET    /api/patrol-route?robotId=                → { robotId, count, waypoints }
//   PUT    /api/patrol-route?robotId=  { waypoints } → 같은 형태 (일괄 교체)
//   POST   /api/patrol-route/points?robotId=  { x, y, yaw?, name?, seq? } → 201 Item
//   DELETE /api/patrol-route/points/{id}             → 204
//   POST   /api/patrol-route/apply?robotId=                           → { status, delivered, count }
//   POST   /api/patrol-route/start?robotId=                           → PatrolStartResult
//
// 목록·편집·하달·시작을 모두 /api/patrol-route 로 모았다(S15P11E101-629).
// 예전에는 CRUD 만 /api/waypoints 였는데, 한 화면이 두 접두사를 쓰면 계약을 좇기 어렵다.
// 두 컨트롤러가 같은 서비스를 부르므로 동작은 같고, 목록 응답 형태만 감싸여 있다.
//
// x/y 는 미터·map 프레임, yaw 는 radians 다 — 화면에서 도(degree)로 바꾸지 않는다.
//
// x/y 는 미터·map 프레임이다. 픽셀→미터 변환은 지도 쪽(navMap.canvasToWorld)이 담당하고
// 여기서는 이미 변환된 값만 다룬다.

import { authedGet, authedSend } from './authApi.ts'
import { ROBOT_ID } from './config.ts'

/** @param {string} [robotId] */
const q = (robotId: string = ROBOT_ID) => (robotId ? `?robotId=${encodeURIComponent(robotId)}` : '')

/**
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').Waypoint[]>}
 */
export function listWaypoints(accessToken: string | null | undefined, robotId?: string) {
  // 응답이 { robotId, count, waypoints } 로 감싸여 온다. 예전 형태(배열·content)도 함께 받아
  // 서버 버전이 섞여 있어도 같은 호출부를 쓴다.
  return authedGet(`/api/patrol-route${q(robotId)}`, accessToken)
    .then((r) => (Array.isArray(r) ? r : (r?.waypoints || r?.content || [])))
}

/**
 * @param {import('./contracts').WaypointRequest} req
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').Waypoint>}
 */
export function addWaypoint(
  { x, y, yaw, name, seq }: import('./contracts').WaypointRequest,
  accessToken: string | null | undefined,
  robotId?: string,
) {
  return authedSend(`/api/patrol-route/points${q(robotId)}`, accessToken, {
    method: 'POST',
    body: { x, y, ...(yaw != null ? { yaw } : {}), ...(name ? { name } : {}), ...(seq != null ? { seq } : {}) },
  })
}

// 목록 전체를 순서대로 교체한다. 순서 변경·이름 수정을 한 번에 반영하는 용도다.
/**
 * @param {Array<import('./contracts').WaypointRequest & { id?: string }>} items
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').Waypoint[]>}
 */
export function replaceWaypoints(
  items: Array<(import('./contracts').WaypointRequest | import('./contracts').Waypoint) & { id?: string }>,
  accessToken: string | null | undefined,
  robotId?: string,
) {
  const body = items.map((w, i) => ({
    x: w.x, y: w.y,
    ...(w.yaw != null ? { yaw: w.yaw } : {}),
    ...(w.name ? { name: w.name } : {}),
    seq: i + 1,
  }))
  // PUT 본문은 배열이 아니라 { waypoints } 로 감싼다(RouteRequest).
  return authedSend(`/api/patrol-route${q(robotId)}`, accessToken, { method: 'PUT', body: { waypoints: body } })
    .then((r) => (Array.isArray(r) ? r : (r?.waypoints || [])))
}

/**
 * @param {string} id
 * @param {string | null | undefined} accessToken
 * @returns {Promise<unknown>}
 */
export function deleteWaypoint(id: string, accessToken: string | null | undefined) {
  // 204 No Content — 본문이 없다. authedSend 는 JSON 파싱 실패를 null 로 흡수한다.
  return authedSend(`/api/patrol-route/points/${encodeURIComponent(id)}`, accessToken, { method: 'DELETE' })
}

// 저장된 경로를 로봇에 하달(SET_PATROL_ROUTE).
// 로봇이 꺼져 있어도 200 이 오고 delivered=false 로 알려준다 — 저장은 이미 끝났으므로
// 재연결 후 다시 누르면 된다. 그 구분을 화면에도 그대로 전한다.
/**
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').WaypointApplyResult>}
 */
export function applyWaypoints(accessToken: string | null | undefined, robotId?: string) {
  return authedSend(`/api/patrol-route/apply${q(robotId)}`, accessToken, { method: 'POST' })
}

// 순찰 시작 — 경로 재하달(SET_PATROL_ROUTE) 직후 SET_MODE autonomy 를 한 번에 처리한다.
//
// 반드시 이 API 로 시작한다. /apply 뒤에 STOMP 로 SET_MODE autonomy 를 따로 보내면 안 된다:
// 로봇이 경로에 저장맵 scouting 세션 ID 를 stamp 하므로(MR !250), 활성 맵이 바뀐 뒤
// 예전 세션 경로로 autonomy 를 요청하면 'route must be reapplied' 로 거절된다.
// 두 명령이 붙어 나가야 세션이 맞는다.
/**
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').PatrolStartResult>}
 */
export function startPatrol(accessToken: string | null | undefined, robotId?: string) {
  return authedSend(`/api/patrol-route/start${q(robotId)}`, accessToken, { method: 'POST' })
}

// 시작 결과를 사람이 읽는 한 줄로 바꾼다. 세 가지가 서로 다른 사건이라 뭉뚱그리지 않는다.
//   NO_ROUTE          — 저장된 경로가 없다. 로봇은 빈 경로로 autonomy 를 거절하므로 보내지도 않는다.
//   routeDelivered=false — 로봇이 꺼져 있다. 경로는 서버에 남아 있다.
//   patrolStarted=false  — 경로는 갔는데 시작 명령이 못 갔다(그 사이 끊김).
/** @param {import('./contracts').PatrolStartResult | null | undefined} r */
export function startPatrolMessage(r: import('./contracts').PatrolStartResult | null | undefined) {
  if (!r) return { kind: 'err', text: '순찰 시작 결과를 받지 못했습니다.' }
  if (r.status === 'NO_ROUTE') {
    return { kind: 'warn', text: '저장된 순찰 경로가 없습니다 — 지점을 찍고 경로 저장을 먼저 하세요.' }
  }
  if (!r.routeDelivered) {
    return { kind: 'warn', text: '로봇이 연결되지 않아 경로가 전달되지 않았습니다 — 로봇이 켜지면 다시 시작하세요.' }
  }
  if (!r.patrolStarted) {
    return { kind: 'warn', text: `경로 ${r.count ?? 0}개 지점은 전달됐지만 순찰 시작 명령이 로봇에 닿지 않았습니다.` }
  }
  return { kind: 'ok', text: `순찰을 시작했습니다 — 경로 ${r.count ?? 0}개 지점.` }
}

/** @param {import('./contracts').Waypoint | null | undefined} w */
export const wpId = (w: import('./contracts').Waypoint | null | undefined) => w?.id ?? null
/** @param {import('./contracts').Waypoint | null | undefined} w @param {number} i */
export const wpLabel = (w: import('./contracts').Waypoint | null | undefined, i: number) => w?.name || `지점 ${i + 1}`
