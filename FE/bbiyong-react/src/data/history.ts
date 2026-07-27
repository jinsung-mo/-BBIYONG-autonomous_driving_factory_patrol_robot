// 과거 일자별 로그 기록 (결정적 목 데이터).
// 오늘(2026-07-16)은 라이브 로그를 쓰고, 미래 일자는 기록 없음.
import type { LogEntry } from '../types'

export const TODAY = 16

export function historyLogs(day: number): LogEntry[] {
  if (day > TODAY) return [] // 미래 — 기록 없음
  const seed = (day * 2654435761) >>> 0
  const bit = (n: number) => ((seed >> (n * 3)) & 0xff) / 255
  const pad = (n: number) => String(n).padStart(2, '0')
  const out: LogEntry[] = []
  let i = 0
  out.push({ id: ++i, time: '08:30:00', kind: 'ok', msg: '상시 순찰 개시 — 시스템 정상' })
  if (bit(1) > 0.45) out.push({ id: ++i, time: `10:${pad(5 + (day % 40))}:00`, kind: 'ok', msg: `정기 열화상 점검 — 분전반 A ${40 + (day % 5)}.${day % 10}°C 정상` })
  if (bit(2) > 0.68) out.push({ id: ++i, time: `13:${pad(10 + (day % 40))}:00`, kind: 'heat', msg: `분전반 B 표면온도 주의 (5${5 - (day % 4)}.${day % 9}°C)` })
  if (bit(3) > 0.82) out.push({ id: ++i, time: `15:${pad(20 + (day % 30))}:00`, kind: 'fire', msg: 'CAM3 화재 의심 탐지 — 오린카 근접 확인 후 오탐 판정' })
  if (bit(4) > 0.6) out.push({ id: ++i, time: `16:${pad(day % 55)}:00`, kind: 'ok', msg: '순찰 경로 재계획 — 장애물 회피 주행' })
  out.push({ id: ++i, time: '18:05:00', kind: 'ok', msg: '야간 순찰 전환 — 이상 없음' })
  return out
}
