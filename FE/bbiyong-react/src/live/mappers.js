// 서버 payload → 기존 화면이 쓰던 표시 형태로 변환.
// 컴포넌트가 서버 스키마를 직접 알지 않도록 이 파일에 매핑을 모은다.
// 계약 원본: docs/fe_backend_integration_guide.md §3.1 (텔레메트리) · §3.2 (경보)

// /topic/robots 의 status → 상태 pill 문구/색
// (modeClass: '' 정상 · 'emg' 긴급 · 'man' 수동 — 기존 CSS 클래스를 그대로 쓴다)
const STATUS_LABEL = {
  AUTO_PATROL: { text: '순찰 중', cls: '' },
  APPROACH: { text: '접근 중', cls: 'emg' },
  VERIFY: { text: '근접 확인', cls: 'emg' },
  MANUAL_CONTROL: { text: '수동 조작', cls: 'man' },
  MAPPING: { text: '맵핑 중', cls: 'man' },
}

const num = (v, digits = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—')

// 텔레메트리 → StatusPanel 표시값. 값이 없으면 '—' 로 비운다(0으로 위장하지 않는다).
export function telemetryToStatus(t) {
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
export function alertToToast(a) {
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

// AlertMessage → 이벤트 로그 한 줄 (LogList 공용 형태)
export function alertToLog(a) {
  return {
    id: a._id,
    time: formatTime(a?.timestamp),
    kind: a?.type === 'FIRE' ? 'fire' : 'heat',
    msg: a?.message || alertToToast(a).sub,
  }
}

// WASD → 방향 단위벡터 (가이드 §4 매핑표).
// 실제 발행값은 여기에 아래 주행 속도를 곱한 것이다 — 로봇이 자체 max로 클램핑한다.
export const DRIVE_VECTORS = {
  w: { linear: 1, angular: 0 },   // 전진
  s: { linear: -1, angular: 0 },  // 후진
  a: { linear: 0, angular: 1 },   // 좌회전
  d: { linear: 0, angular: -1 },  // 우회전
}

// 수동 주행 속도 — 선속도(m/s)이자 각속도(rad/s) 배율로 함께 쓴다.
// 기본값은 기존 발행값(0.5)을 그대로 유지해 이번 변경으로 주행 속도가 달라지지 않게 한다.
export const DEFAULT_DRIVE_SPEED = 0.5
export const DRIVE_SPEED_MIN = 0.1
export const DRIVE_SPEED_MAX = 1.0
export const DRIVE_SPEED_STEP = 0.05

// 0.1 + 0.05 = 0.15000000000000002 같은 잔값이 payload 로 나가지 않도록 정리한다
export function clampDriveSpeed(v) {
  return Number(Math.min(DRIVE_SPEED_MAX, Math.max(DRIVE_SPEED_MIN, v)).toFixed(2))
}

// 서버는 ISO8601(UTC)로 내려준다 — 화면은 기존과 동일하게 로컬 HH:MM:SS로 표시.
function formatTime(iso) {
  if (!iso) return new Date().toTimeString().slice(0, 8)
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toTimeString().slice(0, 8)
}
