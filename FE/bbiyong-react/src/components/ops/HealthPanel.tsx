import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useFleet } from '../../live/FleetContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { errMessage } from '../../live/errors.ts'
import { axisTime, fetchHealthHistory, liveValue, offlineRatio, PERIODS } from '../../live/health.ts'
import { LineChart } from '../ui/Chart.tsx'

type Period = import('../../live/contracts.d.ts').HealthPeriod
type History = import('../../live/contracts.d.ts').RobotHealthHistory

// 1분마다 다시 받는다(가이드 권장). 이력은 분 단위로 쌓이므로 더 자주 부를 이유가 없다.
const REFRESH_MS = 60000

const BATT = '#74A98D'
const LAT = '#C07A72'
const FPS = '#4C5695'

// 로봇 건강 이력 (운영 탭) — GET /api/robots/{id}/health-history
//
// 텔레메트리는 지금 값만 준다. 무인 시간대(20시~08시)에 무슨 일이 있었는지는
// 아침에 이 그래프로만 확인할 수 있다.
export default function HealthPanel() {
  const { enabled } = useLive()
  // 조회 대상은 관제 화면에서 고른 로봇이다(S15P11E101-591)
  const { selected: robotId, robotName, multi } = useFleet()
  const { accessToken } = useAuth()

  const [period, setPeriod] = useState<Period>('24h')
  const [data, setData] = useState<History | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true)
    try {
      const res = await fetchHealthHistory(robotId, period, accessToken)
      if (alive.current) { setData(res); setErr(null) }
    } catch (e) {
      if (alive.current) { setData(null); setErr(errMessage(e)) }
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken, robotId, period])

  useEffect(() => {
    load()
    if (!enabled || !accessToken) return undefined
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load, enabled, accessToken])

  const points = data?.dataPoints ?? []
  const labels = points.map((p) => axisTime(p.timestamp, period))
  const off = offlineRatio(points)
  const last = points[points.length - 1]

  return (
    <div className="card-v3" id="pHealth" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ margin: 0, marginBottom: '12px', flex: 'none' }}>로봇 건강 이력 <span className="k">HEALTH HISTORY</span></h3>
      <p className="cfg-help">
        배터리·통신 지연·추론 FPS 추이입니다. 통신이 끊겼던 구간(<b>online=false</b>)은
        값이 있어도 신뢰할 수 없어 선을 끊어 그립니다.
      </p>

      {!enabled && <div className="cfg-note">시뮬레이션 모드에서는 조회되지 않습니다. 실서버 모드로 로그인하세요.</div>}

      {enabled && (
        <>
          {/* 어느 로봇의 이력인지 분명히 한다 — 편성이 여럿이면 헷갈린다 */}
          {multi && <div className="cfg-note">조회 대상 <b>{robotName(robotId)}</b> — 관제 탭의 편성 로봇에서 바꿉니다.</div>}
          <div className="logfilter" role="group" aria-label="조회 기간">
            {PERIODS.map((p) => (
              <button key={p.value} type="button" className={period === p.value ? 'on' : ''}
                aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>
                {p.label}
              </button>
            ))}
          </div>

          {err && <div className="form-msg err">이력을 불러오지 못했습니다 — {err}</div>}

          {!err && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <LineChart
                labels={labels}
                emptyText={loading ? '조회 중…' : '해당 기간에 기록이 없습니다.'}
                series={[
                  { key: 'batt', label: '배터리', color: BATT, unit: '%', axis: 'left', values: points.map((p) => liveValue(p, 'battery')) },
                  { key: 'lat', label: '통신 지연', color: LAT, unit: 'ms', axis: 'right', values: points.map((p) => liveValue(p, 'commLatencyMs')) },
                  { key: 'fps', label: '추론 FPS', color: FPS, unit: 'fps', axis: 'right', values: points.map((p) => liveValue(p, 'inferenceFps')) },
                ]}
              />
            </div>
          )}

          {!err && points.length > 0 && (
            <div className="cfg-note" style={{ flex: 'none' }}>
              <div>{robotName(robotId)} · 기록 <b>{points.length}점</b></div>
              <div>
                마지막 값 배터리 <b>{last?.battery != null ? `${Math.round(last.battery)}%` : '—'}</b>
                {' · '}지연 <b>{last?.commLatencyMs != null ? `${last.commLatencyMs}ms` : '—'}</b>
                {' · '}FPS <b>{last?.inferenceFps != null ? last.inferenceFps.toFixed(1) : '—'}</b>
              </div>
              {/* 끊긴 시간이 있었다는 사실 자체가 야간 운영에서 가장 중요한 정보다 */}
              {off > 0 && <div className="warn">이 기간의 <b>{Math.round(off * 100)}%</b> 구간에서 로봇이 오프라인이었습니다.</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
