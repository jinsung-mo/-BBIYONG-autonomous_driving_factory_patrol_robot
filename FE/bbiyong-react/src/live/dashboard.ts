// 관제 요약 통계 — GET /api/dashboard/stats (DashboardController)
//
// 로봇 대수·오늘 이벤트 집계·최근 이벤트·로봇 상태를 한 번에 받는다.
// STOMP 텔레메트리는 "지금 이 순간"만 알려 주므로, 누적 수치는 이 API 로만 알 수 있다.

import { authedGet } from './authApi.ts'

/** @returns {Promise<import('./contracts').DashboardStats>} */
export function fetchDashboardStats(accessToken: string | null | undefined) {
  return authedGet('/api/dashboard/stats', accessToken)
}

// 서버가 avgBattery 를 78.5 처럼 소수로 준다. 화면에는 정수로 충분하다.
export const pct = (v: number | null | undefined) =>
  (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—')

// 집계 값이 아직 없으면 0 이 아니라 '—' 로 둔다 — 0건과 미조회를 구분해야 한다.
export const count = (v: number | null | undefined) =>
  (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—')
