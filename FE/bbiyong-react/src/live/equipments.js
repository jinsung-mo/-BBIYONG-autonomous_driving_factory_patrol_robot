// 설비(분전반)별 과열 임계 온도 — S15P11E101-525.
// BE 계약: EquipmentController (S15P11E101-403 · 499).
//
//   GET /api/equipments        → Equipment[]
//        { equipmentId, name, x, y, threshold, lastTemperature, lastInspectedAt, status }
//        status: NORMAL | OVER | UNKNOWN
//   PUT /api/equipments/{id}   { threshold }  (@NotNull @Positive)
//        → { status: 'success' } · 없는 설비면 404
//
// 저장 응답에 갱신된 설비가 들어오지 않는다 — 저장 뒤 목록을 다시 받아야 서버 값이 확정된다.
// 임계값을 바꾸면 BE 가 로봇으로 SET_THRESHOLD 를 중계하므로 FE 가 따로 할 일은 없다.

import { authedGet, authedSend } from './authApi.js'

export function listEquipments(accessToken) {
  return authedGet('/api/equipments', accessToken)
    .then((r) => (Array.isArray(r) ? r : (r?.content || [])))
}

export function updateThreshold(id, threshold, accessToken) {
  return authedSend(`/api/equipments/${encodeURIComponent(id)}`, accessToken, {
    method: 'PUT',
    body: { threshold },
  })
}

// 서버가 양수만 받는다(@Positive). 보내기 전에 걸러 400 을 왕복하지 않는다.
export function thresholdProblem(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '임계 온도는 0보다 큰 수여야 합니다.'
  return null
}

export const STATUS_LABEL = { NORMAL: '정상', OVER: '과열', UNKNOWN: '미점검' }
// 과열은 붉게, 미점검은 흐리게 — 이벤트 로그의 kind 클래스를 그대로 쓴다
export const statusClass = (s) => (s === 'OVER' ? 'heat' : (s === 'NORMAL' ? 'ok' : ''))

export const eqId = (e) => e?.equipmentId ?? e?.id ?? null
export const eqName = (e, i) => e?.name || eqId(e) || `설비 ${i + 1}`

// 마지막 점검 시각 — 날짜까지 붙이면 줄이 길어져 시:분만 쓴다
export function inspectedAt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
