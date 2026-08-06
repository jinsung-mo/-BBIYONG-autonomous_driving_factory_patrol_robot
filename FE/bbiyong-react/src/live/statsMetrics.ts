// 통계 지표 3종 (S15P11E101-768)
//
// 세 지표 모두 BE 전용 집계 API 가 있다. FE 는 받아서 그리기만 한다 —
// 처음에는 이벤트 목록을 받아 FE 에서 세고 배터리 기울기도 직접 구하려 했는데,
// BE 가 같은 계산을 이미 하고 있어 두 벌이 될 뻔했다.
//
// 계약(2026-08-06 BE 확인). 시각은 전부 ISO-8601 UTC.

import { authedGet } from './authApi.ts'

/** GET /api/stats/overheat-equipment — 설비별 과열 랭킹. 이 API 자체가 OVERHEAT 만 집계한다. */
export function fetchOverheatRanking(
  days: number,
  accessToken: string | null | undefined,
  { includeSimulated = false } = {},
) {
  const q = new URLSearchParams({ days: String(days) })
  // 시연용 이벤트는 기본 제외다. 점검 대상을 고르는 화면에 연출된 건이 섞이면 안 된다.
  if (includeSimulated) q.set('includeSimulated', 'true')
  return authedGet(`/api/stats/overheat-equipment?${q}`, accessToken) as
    Promise<import('./contracts.d.ts').OverheatRanking>
}

/** GET /api/stats/alerts-weekly — 일별 화재/과열. 0건인 날도 0 으로 채워 온다. */
export function fetchAlertsWeekly(days: number, accessToken: string | null | undefined) {
  const q = new URLSearchParams({ days: String(days) })
  return authedGet(`/api/stats/alerts-weekly?${q}`, accessToken) as
    Promise<import('./contracts.d.ts').AlertsWeekly>
}

/** GET /api/stats/battery-estimate — BE 가 선형회귀로 구한 소모율과 잔여시간. */
export function fetchBatteryEstimate(robotId: string, accessToken: string | null | undefined) {
  const q = new URLSearchParams({ robotId })
  return authedGet(`/api/stats/battery-estimate?${q}`, accessToken) as
    Promise<import('./contracts.d.ts').BatteryEstimate>
}

/**
 * 분 → '약 2시간 10분'. 잔여시간에 초 단위 정밀도는 뜻이 없다.
 * null 이면 '—' 다 — 충전 중이거나 표본이 모자라 BE 가 추정을 포기한 경우다.
 */
export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(Number(min))) return '—'
  const v = Math.max(0, Math.round(Number(min)))
  if (v < 60) return `약 ${v}분`
  const h = Math.floor(v / 60)
  const m = v % 60
  return m ? `약 ${h}시간 ${m}분` : `약 ${h}시간`
}

/**
 * 추정이 없을 때 그 이유를 말한다.
 * BE 는 이유를 따로 주지 않으므로, 소모율이 오면 '충전 중', 그것마저 없으면 '자료 부족' 이다.
 * 조작자에게는 '왜 모르는지' 가 '모른다' 보다 쓸모 있다.
 */
export function estimateNote(e: import('./contracts.d.ts').BatteryEstimate | null): string | null {
  if (!e) return null
  if (e.estimatedRemainingMinutes != null) return null
  return e.dischargePerHour != null ? '충전 중이거나 소모가 완만합니다' : '추정할 자료가 모자랍니다'
}

/** 'MM/DD' 축 라벨. date 는 Asia/Seoul 로컬 날짜 문자열이라 그대로 잘라 쓴다. */
export const dayLabel = (date: string) => (date || '').slice(5).replace('-', '/')
