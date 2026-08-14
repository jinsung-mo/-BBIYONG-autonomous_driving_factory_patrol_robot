// 로봇 건강 이력 — GET /api/robots/{robotId}/health-history (RobotController)
//
// 텔레메트리(/topic/robot/…)는 지금 값만 준다. "새벽에 통신이 끊겼었나",
// "배터리가 언제부터 떨어졌나"는 이 이력으로만 알 수 있다.

import { authedGet } from './authApi.ts'

type Period = import('./contracts').HealthPeriod

/**
 * @param {string} robotId
 * @param {import('./contracts').HealthPeriod} period
 * @returns {Promise<import('./contracts').RobotHealthHistory>}
 */
export function fetchHealthHistory(
  robotId: string,
  period: Period,
  accessToken: string | null | undefined,
) {
  const q = new URLSearchParams({ period })
  return authedGet(`/api/robots/${encodeURIComponent(robotId)}/health-history?${q}`, accessToken)
}

export const PERIODS: Array<{ value: Period, label: string }> = [
  { value: '1h', label: '1시간' },
  { value: '6h', label: '6시간' },
  { value: '24h', label: '24시간' },
  { value: '7d', label: '7일' },
  { value: '30d', label: '30일' },
]

// 24시간 이하는 시:분, 그 이상은 날짜까지 보여 준다 — 축 라벨이 길어지면 겹친다.
export function axisTime(iso: string, period: Period) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (period === '7d' || period === '30d') return `${d.getMonth() + 1}/${d.getDate()}`
  return hm
}

// 끊긴 구간(online=false)은 값이 있어도 신뢰할 수 없다 — 차트에서 선을 끊는다.
export const liveValue = (p: import('./contracts').HealthDataPoint, key: 'battery' | 'commLatencyMs' | 'inferenceFps') =>
  (p.online === false ? null : (typeof p[key] === 'number' ? (p[key] as number) : null))

/** 이력 전체에서 로봇이 오프라인이던 구간의 비율(0~1). 화면 요약에 쓴다. */
export function offlineRatio(points: import('./contracts').HealthDataPoint[]) {
  if (!points.length) return 0
  return points.filter((p) => p.online === false).length / points.length
}
