import { useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { telemetryToStatus } from '../../live/mappers.ts'
import { fetchDashboardStats } from '../../live/dashboard.ts'

// 화면 맨 위의 큰 숫자들.
//
// 굵기가 아니라 크기로 위계를 만든다 — 숫자는 굵게 쓰지 않는다.
// 값이 없으면 '—' 로 둔다. 없는 수치를 그리면 조작자가 그것을 믿는다.
//
// 배지는 색만으로 알리지 않는다. 정상·주의·위험을 기호와 함께 준다 —
// 색각 이상에서도 읽혀야 한다.
type Tone = 'ok' | 'warn' | 'bad' | 'none'

const SIGN: Record<Tone, string> = { ok: '✓', warn: '!', bad: '⚠', none: '–' }

function Kpi({ value, unit, label, tone = 'none', note }: {
  value: string, unit?: string, label: string, tone?: Tone, note?: string,
}) {
  return (
    <div className="kpi">
      <div>
        <div className="kpi-num">
          {value}{unit && <span className="unit">{unit}</span>}
        </div>
        <div className="kpi-label">{label}</div>
      </div>
      <span className={`kpi-badge ${tone}`} aria-hidden="true">{SIGN[tone]}</span>
      {note && <span className="sr-only">{note}</span>}
    </div>
  )
}

export default function KpiRow() {
  const { status } = useSim()
  const { enabled, connected, telemetry } = useLive()
  const { accessToken } = useAuth()

  const live = enabled ? telemetryToStatus(telemetry) : null
  const batt = live ? live.batt : status.batt

  const battTone: Tone = batt == null ? 'none' : batt <= 15 ? 'bad' : batt <= 35 ? 'warn' : 'ok'

  // 경보 이벤트 — 하루 단위 집계(S15P11E101 콘솔 정리).
  // live: 서버 대시보드 통계의 '오늘 이벤트 건수'(GET /api/dashboard/stats)를 30초 주기로 갱신.
  //       세션에 떠 있는 실시간 경보 수(alerts.length)는 접속 시점에 따라 달라져 하루 집계가 아니다.
  // sim:  오늘 세션 로그 중 화재/과열 건수.
  const [todayCount, setTodayCount] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled || !accessToken) { setTodayCount(null); return undefined }
    let alive = true
    const load = async () => {
      try {
        const res = await fetchDashboardStats(accessToken)
        if (alive) setTodayCount(Number(res?.today?.eventCount ?? 0))
      } catch { /* 조회 실패 시 이전 값 유지 */ }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [enabled, accessToken])

  const simAlarms = (status.logs || []).filter((log: any) => log.kind === 'fire' || log.kind === 'heat').length
  const alarmValue = enabled ? todayCount : simAlarms
  const alarmTone: Tone = alarmValue == null ? 'none' : alarmValue > 0 ? 'bad' : 'none'

  const robotOnline = enabled ? (connected && telemetry?.status !== 'OFFLINE') : true
  const robotTone: Tone = robotOnline ? 'ok' : 'bad'

  return (
    <div className="kpis">
      <Kpi
        value={batt == null ? '—' : String(batt)} unit={batt == null ? undefined : '%'}
        label="배터리" tone={battTone}
      />
      <Kpi
        value={alarmValue == null ? '—' : String(alarmValue)} unit={alarmValue == null ? undefined : '건'}
        label="경보 이벤트 (오늘)" tone={alarmTone}
      />
      <Kpi
        value={robotOnline ? 'ON' : 'OFF'}
        label="로봇 상태" tone={robotTone}
      />
    </div>
  )
}
