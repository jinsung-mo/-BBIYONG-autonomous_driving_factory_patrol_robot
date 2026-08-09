// 서버 payload → 기존 화면이 쓰던 표시 형태로 변환.
// 컴포넌트가 서버 스키마를 직접 알지 않도록 이 파일에 매핑을 모은다.
// 계약 원본: docs/fe_backend_integration_guide.md §3.1 (텔레메트리) · §3.2 (경보)

import { ROBOT_V_MAX, ROBOT_W_MAX, COMM_GOOD_MS, COMM_SLOW_MS } from './config.ts'
import { withDisplayNames } from './robotName.ts'

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

// 통신 품질 등급 (S15P11E101-602). 임계값은 config.ts (COMM_GOOD_MS / COMM_SLOW_MS).
//
// 종전에는 지연시간과 무관하게 '양호'를 문자열에 박아 넣어서, 지연 3,000ms 에도
// "양호 · 3000ms" 가 떴다. 화재 대응 로봇에서 통신 저하를 조작자가 알아챌 유일한 문구가
// 거짓말을 하고 있었다.
//
// 상태 pill 과 같은 규칙으로 색만이 아니라 기호(✓ ▲ ✕)를 함께 준다 — 적록색맹은
// 초록(정상)과 빨강(위험)을 구별하지 못한다(app.css 관례).
export type CommLevel = 'good' | 'slow' | 'bad' | 'down' | 'unknown'

const COMM_GRADE: Record<CommLevel, { label: string, glyph: string, cls: string }> = {
  good: { label: '양호', glyph: '✓', cls: 'ok' },
  slow: { label: '지연', glyph: '▲', cls: 'warn' },
  bad: { label: '불량', glyph: '✕', cls: 'bad' },
  down: { label: '끊김', glyph: '✕', cls: 'bad' },
  unknown: { label: '—', glyph: '', cls: '' },
}

// connected=false 면 지연시간이 얼마였든 '끊김'이다 — 마지막으로 받은 값이 신선해 보이는
// 것과 지금 연결돼 있는 것은 다른 이야기다. 끊긴 뒤에도 마지막 43ms 가 '양호'로 남아
// 있으면 조작자가 명령이 나가고 있다고 오해한다.
export function commGrade(latencyMs: any, connected = true) {
  const of = (level: CommLevel, ms: number | null, text: string) =>
    ({ level, ms, text, ...COMM_GRADE[level] })
  if (!connected) return of('down', null, '끊김')
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return of('unknown', null, '—')
  const ms = Math.round(latencyMs)
  const level: CommLevel = ms <= COMM_GOOD_MS ? 'good' : (ms <= COMM_SLOW_MS ? 'slow' : 'bad')
  return of(level, ms, `${COMM_GRADE[level].label} · ${ms}ms`)
}

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
    // 등급 판정에 필요한 connected 를 이 매퍼는 알 수 없다(위 status 폴백과 같은 이유).
    // 표시하는 쪽이 연결 여부를 알면 commGrade(ms, connected) 를 직접 부르는 편이 정확하다.
    comm: commGrade(t?.commLatencyMs).text,
    location: t?.location || null,
    // 충전 상태 — 로봇이 배터리 % 추세로 추정해 보낸다. 아직 판단이 안 섰거나 구버전
    // 로봇이면 필드가 없다. 그때는 false 로 낮추지 않고 null 로 남긴다: '방전 중'이라고
    // 단정하는 것과 '모른다'는 다른 말이고, 화면도 그렇게 구분해야 한다.
    charging: typeof t?.charging === 'boolean' ? t.charging : null,
    minutesToFull: typeof t?.minutesToFull === 'number' && Number.isFinite(t.minutesToFull)
      ? Math.round(t.minutesToFull)
      : null,
  }
}

// AlertMessage → EventAlert 토스트 (가이드 §6 매핑 규칙)
export function alertToToast(a: any) {
  const time = formatTime(a?.timestamp)
  if (a?.type === 'FIRE') {
    return {
      kind: 'fire',
      title: '화재 발생',
      sub: a.robotId || '',
      time,
    }
  }
  if (a?.type === 'OVERHEAT') {
    return {
      kind: 'heat',
      title: '과열 감지',
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
  return {
    id: `ev-${e?.eventId}`,
    eventId: e?.eventId,   // 서버 삭제(DELETE /api/events/{id}) 대상 — S15P11E101-516
    time: formatTime(e?.timestamp),
    date: formatDate(e?.timestamp),
    // 원본 타임스탬프 — 카드 목록의 "N일 전" 상대 시각 표시에 쓴다(S15P11E101-814).
    // time/date 는 이미 표시용으로 가공(오늘이면 date 비움)돼 있어 상대 일수를 못 구한다.
    ts: e?.timestamp || null,
    kind,
    type: e?.type || 'SYSTEM',
    // 심각도·해결 상태는 필터와 행 표시에 함께 쓴다(관제센터 확장)
    level: e?.level || null,
    status: e?.status || null,
    robotId: e?.robotId || null,
    equipmentId: e?.equipmentId || null,
    // 표시명으로 갈아 끼운다(S15P11E101-766). BE 가 조립한 message 안에 id 가 박혀 오므로
    // 문장 전체를 통과시킨다.
    // 🔴 뒤에 ' · robotId' 를 덧붙이지 않는다(S15P11E101-879) — BE message 에 이미 로봇명이
    // 들어 있어 "로봇 BBIYONGBOT 연결 끊김 · BBIYONGBOT" 처럼 같은 이름이 두 번 찍혔다.
    msg: withDisplayNames(e?.message || TYPE_LABEL[e?.type] || e?.type || '이벤트'),
  }
}

export const TYPE_LABEL: Record<string, string> = { FIRE: '화재 발생', OVERHEAT: '과열 감지', SYSTEM: '시스템' }

// AlertMessage → 이벤트 로그 한 줄 (LogList 공용 형태)
export function alertToLog(a: any) {
  return {
    id: a._id,
    // 저장 완료 뒤 서버가 보낸 이력 식별자. 실시간 행도 상세·해결·삭제 API를 쓸 수 있다.
    eventId: a?.eventId ?? null,
    time: formatTime(a?.timestamp),
    date: formatDate(a?.timestamp),
    ts: a?.timestamp || null,
    kind: a?.type === 'FIRE' ? 'fire' : (a?.type === 'OVERHEAT' ? 'heat' : (a?.level === 'CRITICAL' ? 'heat' : 'ok')),
    type: a?.type || 'SYSTEM',
    level: a?.level || null,
    // 방금 들어온 경보는 아직 아무도 처리하지 않았다 — 해결 상태 필터에서 미해결로 잡힌다
    status: 'UNRESOLVED',
    // 실시간 행은 서버 쿼리를 거치지 않으므로 로봇·설비 필터를 화면에서 적용한다
    robotId: a?.robotId || null,
    equipmentId: a?.equipmentId || null,
    live: true,   // 실시간 수신분 — 히스토리와 구분해 표시한다
    msg: withDisplayNames(a?.message || alertToToast(a).sub),
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

/**
 * 이 위치를 도면 위에 그려도 되는가(S15P11E101-773).
 *
 * 로봇이 로컬라이즈되지 않으면 odom 폴백 pose 가 온다. 그것을 map 좌표로 알고
 * 그리면 도면 위 엉뚱한 자리에 마커가 '자신 있게' 찍힌다 — 틀린 위치를 확신에 차서
 * 보여 주는 것이 가장 나쁘다. 모르면 안 그리는 편이 낫다.
 *
 * frame 이 없는 구버전 텔레메트리는 예전처럼 그린다. 하위호환을 깨면서까지
 * 방어할 일은 아니다.
 */
export function isMapFrame(loc: { frame?: string } | null | undefined) {
  const f = loc?.frame
  if (f == null || f === '') return true          // 구버전 — 기존 동작 유지
  return String(f).toLowerCase() === 'map'
}

/** 위치를 그릴 수 있는가 — 값이 있고, 그 값이 map 프레임인가. */
export function localized(loc: { x?: number, y?: number, frame?: string } | null | undefined) {
  return !!loc && Number.isFinite(Number(loc.x)) && Number.isFinite(Number(loc.y)) && isMapFrame(loc)
}
