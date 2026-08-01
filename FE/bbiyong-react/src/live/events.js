// @ts-check
// 이벤트 이력 API — S15P11E101-464(조회) · 516(삭제).
// BE 계약: EventController (삭제는 S15P11E101-511).
//
//   GET    /api/events?page=&size=&type=  → Spring Page
//   DELETE /api/events/{eventId}          → 204 (없으면 404)
//
// 삭제는 테스트/더미 이벤트 정리용이다. 실시간 경보(/topic/alerts)는
// AlertMessage 에 eventId 가 없어 이 API 의 대상이 될 수 없다 — 이력 행만 지울 수 있다.

import { authedGet, authedSend } from './authApi.js'

/**
 * @param {{ page?: number, size?: number, type?: import('./contracts').EventType | 'ALL' | null }} query
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').EventPage>}
 */
export function fetchEvents({ page = 0, size = 20, type = null }, accessToken) {
  const q = new URLSearchParams({ page: String(page), size: String(size) })
  if (type && type !== 'ALL') q.set('type', type)
  return authedGet(`/api/events?${q}`, accessToken)
}

/**
 * @param {number | string} eventId
 * @param {string | null | undefined} accessToken
 * @returns {Promise<unknown>}
 */
export function deleteEvent(eventId, accessToken) {
  // 204 No Content — 본문이 없다. authedSend 는 JSON 파싱 실패를 null 로 흡수한다.
  return authedSend(`/api/events/${encodeURIComponent(eventId)}`, accessToken, { method: 'DELETE' })
}
