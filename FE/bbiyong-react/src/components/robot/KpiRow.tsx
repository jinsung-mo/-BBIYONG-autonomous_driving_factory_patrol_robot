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

// ── 미니 바차트 (S15P11E101-814) ──────────────────────────────────────────
// 디자인 시스템 v3 의 서명 요소다. 핸드오프의 "구현 시 우선순위" 4번이
// "수치 옆에는 미니 차트를, 라벨은 항상 수치보다 작고 흐리게" 인데 그동안 빠져 있었다.
// 규격(원본 console-v3-standalone-src.html): 74×30 · 막대 2.5px · r1.2 · 간격 6px ·
// 과거는 중립색 · 최근 3개만 상태색. 축·격자선·범례·툴팁 금지 — "추세의 인상"만 준다.
//
// 🔴 데이터를 지어내지 않는다. 아래 useTrend 는 **실제로 관측된 값만** 쌓는다.
// 관측이 3개면 막대도 3개다. 있지도 않은 과거를 그리면 조작자가 그것을 믿는다 —
// 이 파일 맨 위의 "값이 없으면 '—'" 규칙과 같은 이유다.
const SPARK_N = 8
const BAR_W = 2.5, BAR_GAP = 6, SPARK_H = 30, SPARK_PAD = 2

/** 값이 바뀔 때마다 최근 n개를 굴려 담는다. 관측 이력이 없으면 빈 배열이다. */
function useTrend(value: number | null, n = SPARK_N) {
  const [hist, setHist] = useState<number[]>([])
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return
    setHist((h) => (h[h.length - 1] === value ? h : [...h, value].slice(-n)))
  }, [value, n])
  return hist
}

// 스케일 방식 — KPI 마다 "무엇에 대한 비율인지" 가 다르므로 하나로 못 묶는다.
//   'absolute' : 0~max 라는 절대 축이 의미 있는 값(배터리 0~100%). 축이 고정돼 있으므로
//                34 → 33 → 34 처럼 1%p 흔들려도 막대가 거의 안 움직인다 — 그게 맞다.
//                v/max 를 그대로 높이로 쓰면 34% 도 "낮은 편"으로 읽힌다.
//   'relative' : 상한이 없는 값(경보 건수 — 하루에 몇 건이든 나올 수 있다). 절대 축이
//                없으므로 관측 구간의 최소~최대로 스케일해 "지금 구간 안에서 오르내리는
//                인상"만 준다.
type ScaleMode = 'absolute' | 'relative'

function Spark({ hist, tone, scale = 'relative', max = 100 }: {
  hist: number[], tone: Tone, scale?: ScaleMode, max?: number,
}) {
  // 관측이 2개 미만이면 추세라고 부를 수 없다 — 아예 그리지 않는다.
  if (hist.length < 2) return null

  const usable = SPARK_H - SPARK_PAD * 2
  const FLOOR = 3   // 변화가 없을 때(또는 절대 축에서 0)의 높이. 0 이면 아예 사라져 "값 없음"과 헷갈린다.

  // 🔴 이전에는 항상 관측 구간의 최소~최대로 스케일했다. 그러면 배터리처럼 절대 축이
  // 있는 값에서 34 → 33 → 34 같은 1%p 흔들림이 전체 높이로 증폭돼 막대가 들쭉날쭉해
  // 보였다(34% 인데 막대 3개가 크게 달랐다). 배터리는 0~100 이 이미 의미 있는 축이므로
  // absolute 로 그린다 — v/max 를 그대로 높이로 쓴다.
  const lo = scale === 'absolute' ? 0 : Math.min(...hist)
  const hi = scale === 'absolute' ? max : Math.max(...hist)
  const span = hi - lo

  return (
    <svg className="kpi-spark" width={SPARK_N * BAR_GAP} height={SPARK_H} aria-hidden="true">
      {hist.map((v, i) => {
        const h = span > 0
          ? FLOOR + ((v - lo) / span) * (usable - FLOOR)
          : FLOOR
        // 최근 3개만 상태색 — 지금 어느 쪽으로 가고 있는지가 읽혀야 한다.
        const recent = i >= hist.length - 3
        return (
          <rect
            key={i} x={i * BAR_GAP} y={SPARK_H - SPARK_PAD - h}
            width={BAR_W} height={h} rx={BAR_W / 2}
            className={recent ? `on ${tone}` : undefined}
          />
        )
      })}
    </svg>
  )
}

function Kpi({ value, unit, label, tone = 'none', note, trend, scale, max }: {
  value: string, unit?: string, label: string, tone?: Tone, note?: string,
  trend?: number[], scale?: ScaleMode, max?: number,
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
      {trend && <Spark hist={trend} tone={tone} scale={scale} max={max} />}
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

  // 추세는 이 화면이 열려 있는 동안 관측한 값으로만 만든다(과거를 서버에서 끌어오지 않는다).
  // 배터리는 텔레메트리마다, 경보는 30초 폴링마다 한 칸씩 쌓인다.
  // 🔴 로봇 상태(ON/OFF)는 추세가 없다 — 상태이지 값이 아니다. 스파크라인을 그리지 않는다
  // (S15P11E101-814). 그래서 이 KPI 에는 useTrend 를 아예 쓰지 않는다.
  const battTrend = useTrend(batt ?? null)
  const alarmTrend = useTrend(alarmValue ?? null)

  return (
    <div className="kpis">
      <Kpi
        value={batt == null ? '—' : String(batt)} unit={batt == null ? undefined : '%'}
        label="배터리" tone={battTone} trend={battTrend} scale="absolute" max={100}
      />
      <Kpi
        value={alarmValue == null ? '—' : String(alarmValue)} unit={alarmValue == null ? undefined : '건'}
        label="경보 이벤트 (오늘)" tone={alarmTone} trend={alarmTrend} scale="relative"
      />
      <Kpi
        value={robotOnline ? 'ON' : 'OFF'}
        label="로봇 상태" tone={robotTone}
      />
    </div>
  )
}
