import { errMessage, errStatus } from './errors.ts'
// 2D 맵 모델링(SLAM) 흐름 — S15P11E101-483.
//
// 실기로 끝까지 도는 것을 확인했다(2026-08-06). 아래는 지금 도는 경로이고,
// 미확정 항목은 남아 있지 않다 — 계약이 바뀌면 이 파일만 고치면 된다.
//
// - START_MAPPING : BE/로봇 릴레이 (RobotControlStompController#operation).
// - 진행 표시    : 텔레메트리 status === 'MAPPING'. 그동안 순찰 경로 패널은
//                  라이브 매핑 화면으로 바뀐다(S15P11E101-763).
// - 완료 이벤트  : /topic/mapping (EVENT_MAPPING_COMPLETE & FLOORPLAN_READY).
// - 활성 맵 지정 : PUT /api/maps/{id}/active. BE 가 정제 도면(FLOORPLAN)을 자동
//                  활성화하며, 다른 맵을 쓰려면 이 API 로 지정한다.

import { authedGet, authedSend } from './authApi.ts'

export const MAPPING_STATUS = 'MAPPING'

// 완료 이벤트 타입 후보. 티켓 표기는 EVENT_MAPPING_COMPLETE 이지만 서버가 접두어 없이
// 보낼 수도 있어 둘 다 받는다 — 못 받는 것보다 넓게 받는 편이 안전하다.
const COMPLETE_TYPES = new Set(['EVENT_MAPPING_COMPLETE', 'MAPPING_COMPLETE'])

/**
 * @param {unknown} msg
 * @returns {msg is import('./contracts').MappingComplete}
 */
export function isMappingComplete(msg: unknown): msg is import('./contracts.d.ts').MappingComplete {
  const m = (msg || {}) as { type?: unknown, event?: unknown }
  const type = m.type || m.event
  return typeof type === 'string' && COMPLETE_TYPES.has(type.toUpperCase())
}

// ---- 매핑 진행 상태 (S15P11E101-744) ----
//
// 지도 탭은 '지금 매핑 중인가' 에 따라 보여 줄 것이 완전히 다르다. 매핑 중에는
// 아직 도면이 없으므로 진행 안내를 띄우고, 도면이 준비되면 3D 로 전환한다.
//
// 상태는 두 경로로 온다. STOMP 는 붙어 있는 동안의 전환만 주므로, 새로고침이나
// 중간 접속으로 놓친 상태는 REST 로 한 번 읽어 복원해야 한다.
export const PHASE_MAPPING = 'MAPPING'
export const PHASE_IDLE = 'IDLE'

/**
 * @param {unknown} msg
 * @returns {msg is import('./contracts').MappingStatusMessage}
 */
export function isMappingStatus(msg: unknown): msg is import('./contracts.d.ts').MappingStatusMessage {
  return (msg as { type?: unknown } | null)?.type === 'MAPPING_STATUS'
}

/**
 * phase 와 mapping 불리언 중 오는 쪽을 읽는다. 둘 다 없으면 판단하지 않고 null 을
 * 돌려준다 — 모르는 것을 IDLE 로 단정하면 매핑 중인 화면이 도면으로 바뀐다.
 * @param {{ phase?: unknown, mapping?: unknown } | null | undefined} src
 * @returns {import('./contracts').MappingPhase | null}
 */
export function phaseOf(src: any): import('./contracts.d.ts').MappingPhase | null {
  const raw = typeof src?.phase === 'string' ? src.phase.toUpperCase() : null
  if (raw === PHASE_MAPPING || raw === PHASE_IDLE) return raw
  if (typeof src?.mapping === 'boolean') return src.mapping ? PHASE_MAPPING : PHASE_IDLE
  return null
}

export const mapStatusPath = (robotId: string) => `/api/maps/status?robotId=${encodeURIComponent(robotId)}`

/**
 * @param {string} robotId
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').MapStatusResponse>}
 */
export function fetchMapStatus(robotId: string, accessToken: string | null | undefined) {
  return authedGet(mapStatusPath(robotId), accessToken)
}

// 서버 맵 레코드의 식별자·이름 필드가 목록/상세에서 조금씩 달라 흡수한다.
/** @param {(import('./contracts').MapSummary & { mapId?: string }) | null | undefined} m */
export const mapIdOf = (m: any) => m?.id ?? m?.mapId ?? null
/** @param {(import('./contracts').MapSummary & { mapName?: string }) | null | undefined} m */
export const mapNameOf = (m: any) => m?.name ?? m?.mapName ?? null

/**
 * @param {unknown} res
 * @returns {import('./contracts').MapSummary[]}
 */
const listOf = (res: any) => (Array.isArray(res) ? res : (/** @type {any} */ (res)?.content || []))

// 활성 맵. 서버가 플래그를 주면 그것이 정답이고, 없으면 최신(GET /api/maps/latest 기준)을 활성으로 본다.
/** @param {import('./contracts').MapSummary[]} maps */
export function activeMapIdOf(maps: any) {
  const flagged = maps.find((m: any) => m?.active === true)
  return mapIdOf(flagged || maps[0])
}

/**
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').MapSummary[]>}
 */
export function fetchMaps(accessToken: string | null | undefined) {
  return authedGet('/api/maps', accessToken).then(listOf)
}

// SAVE_MAP 은 STOMP 발행이라 응답이 없다. 로봇이 업로드를 끝내면 목록에 나타나므로
// 이름으로 되찾아 활성화 대상 id 를 얻는다.
const POLL_TRIES = 8
const POLL_INTERVAL_MS = 1500

/**
 * @param {string} name
 * @param {string | null | undefined} accessToken
 * @param {{ signal?: { aborted: boolean } }} [opts]
 * @returns {Promise<import('./contracts').MapSummary | null>}
 */
export async function waitForSavedMap(
  name: string,
  accessToken: string | null | undefined,
  { signal }: { signal?: { aborted: boolean } } = {},
) {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    if (signal?.aborted) return null
    let maps
    try { maps = await fetchMaps(accessToken) } catch { continue }
    const hit = maps.find((m: any) => mapNameOf(m) === name)
    if (hit) return hit
  }
  return null
}

// 활성 맵 지정 — PUT /api/maps/{id}/active (MapController, S15P11E101-482).
// 483 당시에는 API 가 없어 PATCH 로 잠정 구현했는데, 실제 계약은 PUT 이라 그대로 두면
// 405 가 난다(S15P11E101-524 에서 확인).
/** @param {string} id */
export const activatePath = (id: any) => `/api/maps/${id}/active`
/**
 * 계약이 정한 메서드를 리터럴로 못 박는다. 483 당시 PATCH 로 잠정 구현했다가 405 가 났다 —
 * 다시 PATCH 로 되돌리면 빌드에서 걸린다(S15P11E101-569).
 * @type {'PUT'}
 */
export const ACTIVATE_METHOD = 'PUT'

export class NotImplementedError extends Error {}

/**
 * @param {string} id
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').MapDetail>}
 */
export async function activateMap(id: any, accessToken: any) {
  try {
    return await authedSend(activatePath(id), accessToken, { method: ACTIVATE_METHOD })
  } catch (e) {
    // 404/405 는 "서버에 그 API 가 없다" 는 뜻 — 사용자에게 실패가 아니라 미구현으로 알린다.
    const st = errStatus(e)
    if (st === 404 || st === 405) throw new NotImplementedError(errMessage(e))
    throw e
  }
}
