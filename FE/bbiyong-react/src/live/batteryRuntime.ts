// 순찰 로봇의 "남은 기동 시간" 계산 (S15P11E101-814).
//
// 🔴 소모율 실측 대기 — S15P11E101-814. 값이 들어오기 전에는 null 을 반환한다.
// 로봇 배터리를 10분간 추적하는 실측이 별도로 진행 중이다. 그 결과(분당 % 소모율)가
// 나오기 전까지 이 상수를 지어내지 않는다 — 없는 수치를 그리면 조작자가 그것을 믿는다.
const PERCENT_PER_MINUTE: number | null = null

/** 현재 배터리 %(0~100)로 남은 기동 시간(분)을 계산한다. 계수가 없으면 null. */
export function estimateRuntimeMinutes(batteryPercent: number | null): number | null {
  if (batteryPercent == null || !Number.isFinite(batteryPercent)) return null
  if (PERCENT_PER_MINUTE == null || PERCENT_PER_MINUTE <= 0) return null
  return Math.max(0, Math.round(batteryPercent / PERCENT_PER_MINUTE))
}
