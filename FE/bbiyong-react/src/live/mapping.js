// 2D 맵 모델링(SLAM) 흐름 — S15P11E101-483.
//
// 계약 근거와 미확정 지점을 한곳에 모아 둔다. 로봇/BE 가 확정되면 이 파일만 고치면 된다.
//
// - START_MAPPING : BE 는 이미 릴레이한다(RobotControlStompController#operation).
//                   다만 로봇 브리지(cloud_bridge.handle_command)는 DRIVE/ESTOP 만 처리하고
//                   나머지는 "알 수 없는 command" 로 떨어뜨린다 → 실로봇 동작은 로봇 파트 구현 이후.
// - 진행 표시    : 텔레메트리 status === 'MAPPING'. 서버 DTO 는 이 값을 기대하지만
//                   현재 cloud_bridge.infer_status() 는 AUTO_PATROL/MANUAL_CONTROL/None 만 반환한다.
// - 완료 이벤트  : 타입 문자열이 계약에 아직 없다. 아래 후보를 모두 받아들인다(관대하게 수신).
// - 활성 맵 지정 : 엔드포인트가 아직 없다. 경로를 한 곳에 두고 404/405 를 "미구현"으로 구분해 알린다.

import { authedGet, authedSend } from './authApi.js'

export const MAPPING_STATUS = 'MAPPING'

// 완료 이벤트 타입 후보. 티켓 표기는 EVENT_MAPPING_COMPLETE 이지만 서버가 접두어 없이
// 보낼 수도 있어 둘 다 받는다 — 못 받는 것보다 넓게 받는 편이 안전하다.
const COMPLETE_TYPES = new Set(['EVENT_MAPPING_COMPLETE', 'MAPPING_COMPLETE'])

export function isMappingComplete(msg) {
  const type = msg?.type || msg?.event
  return typeof type === 'string' && COMPLETE_TYPES.has(type.toUpperCase())
}

// 서버 맵 레코드의 식별자·이름 필드가 목록/상세에서 조금씩 달라 흡수한다.
export const mapIdOf = (m) => m?.id ?? m?.mapId ?? null
export const mapNameOf = (m) => m?.name ?? m?.mapName ?? null

const listOf = (res) => (Array.isArray(res) ? res : (res?.content || []))

// 활성 맵. 서버가 플래그를 주면 그것이 정답이고, 없으면 최신(GET /api/maps/latest 기준)을 활성으로 본다.
export function activeMapIdOf(maps) {
  const flagged = maps.find((m) => m?.active === true)
  return mapIdOf(flagged || maps[0])
}

export function fetchMaps(accessToken) {
  return authedGet('/api/maps', accessToken).then(listOf)
}

// SAVE_MAP 은 STOMP 발행이라 응답이 없다. 로봇이 업로드를 끝내면 목록에 나타나므로
// 이름으로 되찾아 활성화 대상 id 를 얻는다.
const POLL_TRIES = 8
const POLL_INTERVAL_MS = 1500

export async function waitForSavedMap(name, accessToken, { signal } = {}) {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    if (signal?.aborted) return null
    let maps
    try { maps = await fetchMaps(accessToken) } catch { continue }
    const hit = maps.find((m) => mapNameOf(m) === name)
    if (hit) return hit
  }
  return null
}

// 활성 맵 지정. BE 에 아직 없는 API 라 경로를 여기 한 줄로 고정해 둔다.
export const activatePath = (id) => `/api/maps/${id}/active`

export class NotImplementedError extends Error {}

export async function activateMap(id, accessToken) {
  try {
    return await authedSend(activatePath(id), accessToken, { method: 'PATCH' })
  } catch (e) {
    // 404/405 는 "서버에 그 API 가 없다" 는 뜻 — 사용자에게 실패가 아니라 미구현으로 알린다.
    if (e.status === 404 || e.status === 405) throw new NotImplementedError(e.message)
    throw e
  }
}
