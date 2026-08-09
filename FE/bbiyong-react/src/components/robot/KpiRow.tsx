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

// 미니 바차트(스파크라인)는 걷어냈다 [사용자 지시 2026-08-09].
// S15P11E101-814 에서 디자인 시스템 v3 의 서명 요소로 넣었지만, 이 줄에 남은 KPI 셋 중
// 어느 것도 추세로 읽을 값이 아니었다 — 배터리는 잔량 게이지(아래 Gauge)로 바뀌었고,
// 로봇 상태는 값이 아니라 상태이며, 경보 건수는 숫자 하나로 충분하다.
// 되살릴 일이 있으면 git 이력에 있다(이 커밋 이전 KpiRow.tsx 의 Spark/useTrend).

/** 남은 양을 가로 막대의 **길이**로 보여 준다 — 값이 클수록 오른쪽으로 길어진다.
 *
 * 🔴 배터리에 스파크라인(세로 막대 추세)을 쓰면 안 되는 이유 [사용자 지적 2026-08-09]:
 * 스파크라인은 폭이 항상 꽉 차 있고 높이만 변한다. 그래서 33% 일 때 "막대가 8칸 다
 * 차 있는데 키만 작은" 모양이 되고, 게이지로 읽는 사람은 "거의 다 찼다"로 오해한다.
 * 게다가 배터리는 분당 0.207% 씩 줄어서(batteryRuntime.ts) 8칸 관측 구간 안에서는
 * 사실상 평평하다 — 추세로 그릴 값이 애초에 아니었다.
 *
 * 잔량은 "지금 얼마나 남았나" 하나만 답하면 되고, 그건 길이가 가장 빨리 읽힌다. */
function Gauge({ pct, tone }: { pct: number, tone: Tone }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div className="kpi-gauge" aria-hidden="true">
      <i className={tone} style={{ width: `${w}%` }} />
    </div>
  )
}

function Kpi({ value, unit, label, tone = 'none', note, gauge }: {
  value: string, unit?: string, label: string, tone?: Tone, note?: string,
  gauge?: number | null,
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
      {/* 값이 없으면 빈 게이지조차 그리지 않는다 — 0% 로 보이면 '다 닳았다'로 읽힌다. */}
      {gauge != null && <Gauge pct={gauge} tone={tone} />}
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
      {/* 배터리는 추세가 아니라 **잔량 게이지**다 — 값이 클수록 막대가 오른쪽으로 길어진다.
          스파크라인이던 시절에는 폭이 늘 꽉 차 있고 높이만 낮아서, 33% 인데도 "거의 다 찼다"로
          보였다 [사용자 지적 2026-08-09]. Gauge 주석에 이유를 자세히 적어 뒀다. */}
      <Kpi
        value={batt == null ? '—' : String(batt)} unit={batt == null ? undefined : '%'}
        label="배터리" tone={battTone} gauge={batt ?? null}
      />
      {/* 🔴 스파크라인을 뗐다 [사용자 지시 2026-08-09] — 숫자만 있으면 된다.
          이 값이 답해야 하는 질문은 "오늘 몇 건인가" 하나이고, 그건 숫자가 이미 답한다.
          게다가 추세는 화면이 열려 있는 동안 30초 폴링으로만 쌓여서, 방금 들어온 사람에게는
          막대가 한두 개뿐이고 오래 켜 둔 사람에게는 여덟 개다 — 같은 상황이 사람마다
          다르게 보이는 그림이었다. */}
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
