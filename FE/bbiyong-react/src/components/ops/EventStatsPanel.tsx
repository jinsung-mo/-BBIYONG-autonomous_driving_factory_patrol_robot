import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { errMessage } from '../../live/errors.ts'
import { fetchEventStats, isTimeSeries, STATS_GROUP_LABEL } from '../../live/events.ts'
import { TYPE_LABEL } from '../../live/mappers.ts'
import { BarChart, LineChart } from '../ui/Chart.tsx'

type Group = import('../../live/contracts.d.ts').EventStatsGroup
type Stats = import('../../live/contracts.d.ts').EventStats

const GROUPS: Group[] = ['hour', 'day', 'robot', 'equipment', 'type']

// 기간 선택지는 묶음 기준마다 다르다 — 시간별에 '30일'을 주면 720개 막대가 된다.
const SPANS: Record<Group, number[]> = {
  hour: [6, 12, 24, 48],
  day: [7, 14, 30],
  robot: [7, 30],
  equipment: [7, 30],
  type: [7, 30],
}

const CRIT = '#ff6b6b'
const WARN = '#ffc14d'

// 이벤트 통계 (운영 탭) — /api/events/stats/*
//
// 시간별·일별은 시계열이라 꺾은선, 로봇/설비/유형별은 항목 비교라 누적 막대로 그린다.
// 서버가 timestamp 를 null 로 주는 것이 그 구분과 정확히 일치한다.
export default function EventStatsPanel() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()

  const [group, setGroup] = useState<Group>('day')
  const [span, setSpan] = useState(7)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true); setErr(null)
    try {
      const res = await fetchEventStats(group, span, accessToken)
      if (alive.current) setStats(res)
    } catch (e) {
      // 실패하면 직전 차트를 남기지 않는다 — 다른 조건의 그림을 현재 조건으로 오해한다
      if (alive.current) { setStats(null); setErr(errMessage(e)) }
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken, group, span])

  useEffect(() => { load() }, [load])

  // 묶음 기준을 바꾸면 기간 선택지도 바뀐다 — 이전 값이 목록에 없으면 첫 값으로 맞춘다
  const onGroup = (g: Group) => {
    setGroup(g)
    if (!SPANS[g].includes(span)) setSpan(SPANS[g][0])
  }

  const points = stats?.dataPoints ?? []
  // 유형별 label 은 FIRE/OVERHEAT/SYSTEM 원문이라 한글로 바꿔 준다
  const labelOf = (l: string) => (group === 'type' ? (TYPE_LABEL[l] || l) : l)
  const total = points.reduce((s, p) => s + (p.totalCount || 0), 0)
  const critical = points.reduce((s, p) => s + (p.criticalCount || 0), 0)
  const unresolved = points.reduce((s, p) => s + (p.unresolvedCount || 0), 0)

  return (
    <div className="panel" id="pEventStats">
      <h3>이벤트 통계 <span className="k">EVENT STATS</span></h3>
      <p className="cfg-help">
        기간 내 화재·과열·시스템 이벤트 발생 추이입니다. 막대/선의 색은 심각도이며,
        점 위에 마우스를 올리면 정확한 건수가 나옵니다.
      </p>

      {!enabled && <div className="cfg-note">시뮬레이션 모드에서는 조회되지 않습니다. 실서버 모드로 로그인하세요.</div>}

      {enabled && (
        <>
          <div className="logfilter" role="group" aria-label="통계 묶음 기준">
            {GROUPS.map((g) => (
              <button key={g} type="button" className={group === g ? 'on' : ''}
                aria-pressed={group === g} onClick={() => onGroup(g)}>
                {STATS_GROUP_LABEL[g]}
              </button>
            ))}
          </div>
          <div className="logfilter2">
            <select aria-label="조회 기간" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
              {SPANS[group].map((v) => (
                <option key={v} value={v}>{group === 'hour' ? `최근 ${v}시간` : `최근 ${v}일`}</option>
              ))}
            </select>
            <button type="button" className="dbtn" onClick={() => load()} disabled={loading}>
              {loading ? '조회 중…' : '새로 고침'}
            </button>
          </div>

          {err && <div className="form-msg err">통계를 불러오지 못했습니다 — {err}</div>}

          {!err && (isTimeSeries(group)
            ? (
              <LineChart
                labels={points.map((p) => labelOf(p.label))}
                emptyText={loading ? '조회 중…' : '해당 기간에 이벤트가 없습니다.'}
                series={[
                  { key: 'crit', label: '긴급', color: CRIT, unit: '건', values: points.map((p) => p.criticalCount ?? 0) },
                  { key: 'warn', label: '경고', color: WARN, unit: '건', values: points.map((p) => p.warningCount ?? 0) },
                ]}
              />
            )
            : (
              <BarChart
                emptyText={loading ? '조회 중…' : '해당 기간에 이벤트가 없습니다.'}
                bars={points.map((p) => ({
                  label: labelOf(p.label),
                  parts: [
                    { key: 'crit', name: '긴급', value: p.criticalCount ?? 0, color: CRIT },
                    { key: 'warn', name: '경고', value: p.warningCount ?? 0, color: WARN },
                  ],
                }))}
              />
            ))}

          {!err && points.length > 0 && (
            <div className="cfg-note">
              합계 <b>{total}건</b> · 긴급 <b>{critical}건</b> · 미해결 <b>{unresolved}건</b>
            </div>
          )}
        </>
      )}
    </div>
  )
}
