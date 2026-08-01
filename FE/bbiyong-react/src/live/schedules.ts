// 자동 순찰 스케줄 — /api/patrol-schedules (PatrolScheduleController)
//
// 삐용은 20시~08시 공장이 빈 시간에만 돈다. 지금은 사람이 퇴근 전에 직접 시작하지만,
// 스케줄을 걸어 두면 그 시각에 서버가 순찰을 띄운다.
//
// cron 은 Spring 표현식이라 **6필드**(초 분 시 일 월 요일)다. 표준 5필드를 넣으면
// 서버가 400 을 준다(PatrolScheduleService.validateCronExpression).

import { authedGet, authedSend } from './authApi.ts'

type Schedule = import('./contracts').PatrolSchedule
type ScheduleRequest = import('./contracts').PatrolScheduleRequest

/**
 * @param {string | null | undefined} robotId 주면 그 로봇 것만 조회한다
 * @returns {Promise<import('./contracts').PatrolSchedule[]>}
 */
export async function fetchSchedules(robotId: string | null | undefined, accessToken: string | null | undefined) {
  const q = robotId ? `?${new URLSearchParams({ robotId })}` : ''
  const rows = await authedGet(`/api/patrol-schedules${q}`, accessToken)
  return (Array.isArray(rows) ? rows : []) as Schedule[]
}

/** @returns {Promise<import('./contracts').PatrolSchedule>} */
export function createSchedule(body: ScheduleRequest, accessToken: string | null | undefined) {
  return authedSend('/api/patrol-schedules', accessToken, { method: 'POST', body })
}

/** @returns {Promise<import('./contracts').PatrolSchedule>} */
export function updateSchedule(
  scheduleId: number,
  body: ScheduleRequest,
  accessToken: string | null | undefined,
) {
  return authedSend(`/api/patrol-schedules/${scheduleId}`, accessToken, { method: 'PUT', body })
}

/** @returns {Promise<unknown>} 204 No Content */
export function deleteSchedule(scheduleId: number, accessToken: string | null | undefined) {
  return authedSend(`/api/patrol-schedules/${scheduleId}`, accessToken, { method: 'DELETE' })
}

// ---- cron 도우미 ----
//
// cron 을 손으로 쓰게 두면 대부분 틀린다. 운영에서 실제로 쓸 만한 것만 골라 두고,
// 직접 입력도 열어 둔다(그 경우 형식만 봐 주고 판정은 서버에 맡긴다).
export const CRON_PRESETS: Array<{ value: string, label: string }> = [
  { value: '0 0 20 * * *', label: '매일 20:00 — 퇴근 후 순찰 시작' },
  { value: '0 0 22 * * *', label: '매일 22:00' },
  { value: '0 0 2 * * *', label: '매일 02:00 — 심야 점검' },
  { value: '0 0 20 * * MON-FRI', label: '평일 20:00' },
  { value: '0 0 */2 * * *', label: '2시간마다' },
  { value: '0 0 */6 * * *', label: '6시간마다' },
]

const DOW: Record<string, string> = {
  MON: '월', TUE: '화', WED: '수', THU: '목', FRI: '금', SAT: '토', SUN: '일',
  '0': '일', '1': '월', '2': '화', '3': '수', '4': '목', '5': '금', '6': '토', '7': '일',
}

const dowText = (f: string) =>
  f.split(',').map((part) => part.split('-').map((d) => DOW[d.toUpperCase()] ?? d).join('~')).join('·')

/**
 * cron 을 사람이 읽는 문구로 바꾼다. 해석하지 못하면 null 을 돌려주고
 * 화면은 표현식을 그대로 보여 준다 — 틀린 설명을 보여 주는 것보다 낫다.
 * @param {string} expr
 */
export function cronText(expr: string): string | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 6) return null
  const [sec, min, hour, dom, mon, dow] = f
  if (sec !== '0' || dom !== '*' || mon !== '*') return null

  const every = hour.match(/^\*\/(\d+)$/)
  if (every && min === '0') return `${every[1]}시간마다`
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(min)) return null

  const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (dow === '*') return `매일 ${at}`
  const days = dowText(dow)
  return days === dow ? null : `${days}요일 ${at}`
}

/** 형식만 본다 — 유효성 판정은 서버(CronExpression.parse)가 최종이다. */
export function cronProblem(expr: string): string | null {
  const v = expr.trim()
  if (!v) return 'Cron 표현식을 입력하세요.'
  const n = v.split(/\s+/).length
  if (n === 5) return 'Spring 표현식은 6필드입니다 — 맨 앞에 초를 넣으세요 (예: 0 0 20 * * *).'
  if (n !== 6) return `6필드여야 합니다 (지금 ${n}개).`
  return null
}

// lastExecuted 는 한 번도 안 돌았으면 없다.
export const lastRunText = (iso: string | null | undefined) => {
  if (!iso) return '실행된 적 없음'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ko-KR', { hour12: false })
}
