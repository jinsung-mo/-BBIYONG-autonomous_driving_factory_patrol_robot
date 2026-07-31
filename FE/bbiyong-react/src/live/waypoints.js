// 순찰 지점(waypoint) API — S15P11E101-514.
// BE 계약: WaypointController (S15P11E101-509).
//
//   POST   /api/waypoints?robotId=       { x, y, yaw?, name?, seq? }  → 201 Item
//   GET    /api/waypoints?robotId=                                    → Item[] (순서대로)
//   PUT    /api/waypoints?robotId=       WaypointRequest[]            → Item[]  (일괄 교체)
//   DELETE /api/waypoints/{id}                                        → 204
//   POST   /api/waypoints/apply?robotId=                              → { status, delivered, count }
//
// x/y 는 미터·map 프레임이다. 픽셀→미터 변환은 지도 쪽(navMap.canvasToWorld)이 담당하고
// 여기서는 이미 변환된 값만 다룬다.

import { authedGet, authedSend } from './authApi.js'
import { ROBOT_ID } from './config.js'

const q = (robotId = ROBOT_ID) => (robotId ? `?robotId=${encodeURIComponent(robotId)}` : '')

export function listWaypoints(accessToken, robotId) {
  return authedGet(`/api/waypoints${q(robotId)}`, accessToken).then((r) => (Array.isArray(r) ? r : (r?.content || [])))
}

export function addWaypoint({ x, y, yaw, name, seq }, accessToken, robotId) {
  return authedSend(`/api/waypoints${q(robotId)}`, accessToken, {
    method: 'POST',
    body: { x, y, ...(yaw != null ? { yaw } : {}), ...(name ? { name } : {}), ...(seq != null ? { seq } : {}) },
  })
}

// 목록 전체를 순서대로 교체한다. 순서 변경·이름 수정을 한 번에 반영하는 용도다.
export function replaceWaypoints(items, accessToken, robotId) {
  const body = items.map((w, i) => ({
    x: w.x, y: w.y,
    ...(w.yaw != null ? { yaw: w.yaw } : {}),
    ...(w.name ? { name: w.name } : {}),
    seq: i + 1,
  }))
  return authedSend(`/api/waypoints${q(robotId)}`, accessToken, { method: 'PUT', body })
    .then((r) => (Array.isArray(r) ? r : []))
}

export function deleteWaypoint(id, accessToken) {
  // 204 No Content — 본문이 없다. authedSend 는 JSON 파싱 실패를 null 로 흡수한다.
  return authedSend(`/api/waypoints/${encodeURIComponent(id)}`, accessToken, { method: 'DELETE' })
}

// 저장된 경로를 로봇에 하달(SET_PATROL_ROUTE).
// 로봇이 꺼져 있어도 200 이 오고 delivered=false 로 알려준다 — 저장은 이미 끝났으므로
// 재연결 후 다시 누르면 된다. 그 구분을 화면에도 그대로 전한다.
export function applyWaypoints(accessToken, robotId) {
  return authedSend(`/api/waypoints/apply${q(robotId)}`, accessToken, { method: 'POST' })
}

export const wpId = (w) => w?.id ?? null
export const wpLabel = (w, i) => w?.name || `지점 ${i + 1}`
