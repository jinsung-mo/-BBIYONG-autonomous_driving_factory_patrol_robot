// 서버 payload → 기존 화면이 쓰던 표시 형태로 변환.
// 컴포넌트가 서버 스키마를 직접 알지 않도록 이 파일에 매핑을 모은다.
// 계약 원본: docs/fe_backend_integration_guide.md §3.1 (텔레메트리) · §3.2 (경보)

import { ROBOT_V_MAX, ROBOT_W_MAX } from './config.ts'

// /topic/robots 의 status → 상태 pill 문구/색
// (modeClass: '' 정상 · 'emg' 긴급 · 'man' 수동 — 기존 CSS 클래스를 그대로 쓴다)
const STATUS_LABEL: Record<string, { text: string, cls: string }> = {
  AUTO_PATROL: { text: '순찰 중', cls: '' },
  APPROACH: { text: '접근 중', cls: 'emg' },
  VERIFY: { text: '근접 확인', cls: 'emg' },
  MANUAL_CONTROL: { text: '수동 조작', cls: 'man' },
  MAPPING: { text: '맵핑 중', cls: 'man' },
}

const num = (v: any, digits = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—')

// 텔레메트리 → StatusPanel 표시값. 값이 없으면 '—' 로 비운다(0으로 위장하지 않는다).
export function telemetryToStatus(t: any) {
  // status 미상은 '대기'로만 말한다 — 연결 여부는 이 매퍼가 알 수 없으므로 표시하는 쪽(connected)이 판단한다.
  // 예전 폴백이 '연결 대기'라 연결이 멀쩡해도 텔레메트리에 status 가 없으면 끊긴 것처럼 보였다.
  const label = STATUS_LABEL[t?.status] || { text: t?.status || '대기', cls: '' }
  return {
    modeText: label.text,
    modeClass: label.cls,
    batt: typeof t?.battery === 'number' ? Math.round(t.battery) : null,
    spd: typeof t?.speed === 'number' ? `${num(t.speed)} m/s` : '—',
    estop: t?.estop || '—',
    comm: typeof t?.commLatencyMs === 'number' ? `양호 · ${Math.round(t.commLatencyMs)}ms` : '—',
    location: t?.location || null,
  }
}

// AlertMessage → EventAlert 토스트 (가이드 §6 매핑 규칙)
export function alertToToast(a: any) {
  const time = formatTime(a?.timestamp)
  if (a?.type === 'FIRE') {
    return {
      kind: 'fire',
      title: '🔥 화재 발생',
      sub: `🤖 ${a.robotId || '순찰 로봇'} 확정 · 신뢰도 ${a.confidence != null ? `${Math.round(a.confidence * 100)}%` : '—'}`,
      time,
    }
  }
  if (a?.type === 'OVERHEAT') {
    return {
      kind: 'heat',
      title: '⚠ 분전반 과열 의심',
      sub: `${a.equipmentId || '설비'} · ${num(a.temperature)}℃${a.threshold != null ? ` (임계 ${num(a.threshold)}℃)` : ''}`,
      time,
    }
  }
  return { kind: 'heat', title: a?.type || '경보', sub: a?.message || '', time }
}

// GET /api/events 의 한 건 → 이벤트 로그 한 줄.
// 실시간 경보(AlertMessage)와 필드 이름이 달라(eventId/timestamp/temperature) 여기서 흡수한다.
export function eventToLog(e: any) {
  const kind = e?.type === 'FIRE' ? 'fire' : (e?.type === 'OVERHEAT' ? 'heat' : 'ok')
  const detail = e?.type === 'FIRE'
    ? `신뢰도 ${e.confidence != null ? `${Math.round(e.confidence * 100)}%` : '—'}`
    : (e?.temperature != null ? `${num(e.temperature)}℃` : '')
  return {
    id: `ev-${e?.eventId}`,
    eventId: e?.eventId,   // 서버 삭제(DELETE /api/events/{id}) 대상 — S15P11E101-516
    time: formatTime(e?.timestamp),
    date: formatDate(e?.timestamp),
    kind,
    type: e?.type || 'SYSTEM',
    // 심각도·해결 상태는 필터와 행 표시에 함께 쓴다(관제센터 확장)
    level: e?.level || null,
    status: e?.status || null,
    msg: [TYPE_LABEL[e?.type] || e?.type || '이벤트', e?.robotId, detail].filter(Boolean).join(' · '),
  }
}

export const TYPE_LABEL: Record<string, string> = { FIRE: '화재', OVERHEAT: '과열', SYSTEM: '시스템' }

// AlertMessage → 이벤트 로그 한 줄 (LogList 공용 형태)
export function alertToLog(a: any) {
  return {
    id: a._id,
    time: formatTime(a?.timestamp),
    date: formatDate(a?.timestamp),
    kind: a?.type === 'FIRE' ? 'fire' : 'heat',
    type: a?.type || 'SYSTEM',
    level: a?.level || null,
    // 방금 들어온 경보는 아직 아무도 처리하지 않았다 — 해결 상태 필터에서 미해결로 잡힌다
    status: 'UNRESOLVED',
    live: true,   // 실시간 수신분 — 히스토리와 구분해 표시한다
    msg: a?.message || alertToToast(a).sub,
  }
}

// WASD → 방향 단위벡터 (가이드 §4 매핑표).
// 실제 발행값은 여기에 아래 주행 속도를 곱한 것이다 — 로봇이 자체 max로 클램핑한다.
export const DRIVE_VECTORS: Record<string, { linear: number, angular: number }> = {
  w: { linear: 1, angular: 0 },   // 전진
  s: { linear: -1, angular: 0 },  // 후진
  a: { linear: 0, angular: 1 },   // 좌회전
  d: { linear: 0, angular: -1 },  // 우회전
}

// 수동 주행 속도(선속도, m/s). 슬라이더가 다루는 값이 곧 로봇에 나가는 linear 다.
//
// 범위·증감·기본값을 모두 로봇 상한에서 끌어낸다 — 상한이 바뀌면 config 의 ROBOT_V_MAX
// 하나만 고치면 슬라이더가 통째로 따라온다. 상한을 넘겨 보내도 로봇이 잘라버려
// 슬라이더 표시만 거짓이 되므로, 화면 범위를 로봇에 맞추는 것이 맞다(S15P11E101-463).
const r2 = (v: any) => Number(v.toFixed(2))

// 상한은 설정 탭에서 바꿀 수 있다(S15P11E101-475) — 값을 받아 그때그때 계산한다.
// env 의 ROBOT_V_MAX 는 설정이 없을 때의 기본값 역할만 한다.
export function speedParams(vMax = ROBOT_V_MAX) {
  const max = r2(vMax)
  return {
    max,
    min: Math.max(0.01, r2(vMax * 0.1)),
    step: Math.max(0.01, r2(vMax / 20)),   // 20단계
    def: r2(vMax * 0.5),
  }
}

// 0.1 + 0.05 = 0.15000000000000002 같은 잔값이 payload 로 나가지 않도록 정리한다
export function clampDriveSpeed(v: any, vMax = ROBOT_V_MAX) {
  const p = speedParams(vMax)
  return r2(Math.min(p.max, Math.max(p.min, v)))
}

// 선속도 배율을 각속도에 그대로 쓰면 안 된다 — 로봇 상한이 서로 다르다(V / W).
// 슬라이더가 상한의 몇 %인지를 각속도 상한에 같은 비율로 적용한다.
// 각속도 상한도 서버 설정을 따른다(S15P11E101-515) — env 값은 서버 값이 없을 때의 기본값이다.
export const angularFor = (speed: any, vMax = ROBOT_V_MAX, wMax = ROBOT_W_MAX) => r2((speed / vMax) * wMax)

// 기본 주행 속도 — LiveContext 의 초기값
export const DEFAULT_DRIVE_SPEED = speedParams().def

// 서버는 ISO8601(UTC)로 내려준다 — 화면은 기존과 동일하게 로컬 HH:MM:SS로 표시.
function formatTime(iso: any) {
  if (!iso) return new Date().toTimeString().slice(0, 8)
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toTimeString().slice(0, 8)
}

// 과거 이력은 날짜가 있어야 언제 일인지 알 수 있다. 오늘 것은 날짜를 생략해 줄을 아낀다.
function formatDate(iso: any) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
