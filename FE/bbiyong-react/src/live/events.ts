// 이벤트 이력 API — S15P11E101-464(조회) · 516(삭제) · 관제센터 확장(필터·통계).
// BE 계약: EventController (삭제는 S15P11E101-511).
//
//   GET    /api/events?page=&size=&type=&level=&status=&robotId=&equipmentId=&startDate=&endDate=
//   GET    /api/events/stats/{hourly|daily|by-robot|by-equipment|by-type}
//   DELETE /api/events/{eventId}          → 204 (없으면 404)
//
// 삭제는 테스트/더미 이벤트 정리용이다. 실시간 경보도 저장 완료 eventId를 받으면
// 이 API의 대상이 된다.

import { authedGet, authedSend } from './authApi.ts'

type Filters = import('./contracts').EventFilters

// 빈 문자열·null 을 그대로 실으면 서버가 "그 값으로 필터"로 읽는다. 값이 있는 것만 넣는다.
function withFilters(q: URLSearchParams, f: Filters) {
  const keys: Array<keyof Filters> = ['type', 'level', 'status', 'robotId', 'equipmentId', 'startDate', 'endDate']
  for (const k of keys) {
    const v = f[k]
    if (v) q.set(k, String(v))
  }
  return q
}

/**
 * @param {{ page?: number, size?: number } & import('./contracts').EventFilters} query
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').EventPage>}
 */
export function fetchEvents(
  { page = 0, size = 20, ...filters }: { page?: number, size?: number } & Filters,
  accessToken: string | null | undefined,
) {
  const q = withFilters(new URLSearchParams({ page: String(page), size: String(size) }), filters)
  return authedGet(`/api/events?${q}`, accessToken)
}

// 해결 처리 — PATCH /api/events/{eventId} { status } (S15P11E101-593)
//
// 서버는 UNRESOLVED | RESOLVED 만 받고(EventLogService.updateStatus) 그 밖의 값에 400 을 준다.
// 방향을 가리지 않으므로 되돌리기(RESOLVED → UNRESOLVED)도 같은 호출이다.
// 응답은 갱신된 EventLog 한 건이라 목록을 다시 받지 않고 그 행만 바꿀 수 있다.
/**
 * @param {number | string} eventId
 * @param {import('./contracts').EventStatus} status
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').EventLog>}
 */
export function updateEventStatus(
  eventId: number | string,
  status: import('./contracts').EventStatus,
  accessToken: string | null | undefined,
) {
  return authedSend(`/api/events/${encodeURIComponent(eventId)}`, accessToken, {
    method: 'PATCH',
    body: { status },
  })
}

/**
 * @param {number | string} eventId
 * @param {string | null | undefined} accessToken
 * @returns {Promise<unknown>}
 */
export function deleteEvent(eventId: number | string, accessToken: string | null | undefined) {
  // 204 No Content — 본문이 없다. authedSend 는 JSON 파싱 실패를 null 로 흡수한다.
  return authedSend(`/api/events/${encodeURIComponent(eventId)}`, accessToken, { method: 'DELETE' })
}

// ---- 통계 (차트용) ----
//
// 다섯 엔드포인트가 응답 형태(EventStatsResponse)를 공유하고 기간 파라미터 이름만 다르다.
// hourly 만 hours 이고 나머지는 days 다 — 이름을 틀리면 서버가 조용히 기본값을 쓴다.
const STATS_PATH: Record<import('./contracts').EventStatsGroup, string> = {
  hour: '/api/events/stats/hourly',
  day: '/api/events/stats/daily',
  robot: '/api/events/stats/by-robot',
  equipment: '/api/events/stats/by-equipment',
  type: '/api/events/stats/by-type',
}

/**
 * @param {import('./contracts').EventStatsGroup} group
 * @param {number | null | undefined} span hour 는 시간 수, 나머지는 일수. 없으면 서버 기본값(24 / 7).
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').EventStats>}
 */
export function fetchEventStats(
  group: import('./contracts').EventStatsGroup,
  span: number | null | undefined,
  accessToken: string | null | undefined,
) {
  const path = STATS_PATH[group]
  if (!span) return authedGet(path, accessToken)
  const q = new URLSearchParams({ [group === 'hour' ? 'hours' : 'days']: String(span) })
  return authedGet(`${path}?${q}`, accessToken)
}

export const STATS_GROUP_LABEL: Record<import('./contracts').EventStatsGroup, string> = {
  hour: '시간별', day: '일별', robot: '로봇별', equipment: '설비별', type: '유형별',
}

// 로봇·설비·유형별은 시계열이 아니다(timestamp 가 null 로 온다) — 꺾은선 대신 막대로 그린다.
export const isTimeSeries = (group: import('./contracts').EventStatsGroup) =>
  group === 'hour' || group === 'day'

export const LEVEL_LABEL: Record<string, string> = { CRITICAL: '긴급', WARNING: '경고' }
export const EVENT_STATUS_LABEL: Record<string, string> = { UNRESOLVED: '미해결', RESOLVED: '해결' }
