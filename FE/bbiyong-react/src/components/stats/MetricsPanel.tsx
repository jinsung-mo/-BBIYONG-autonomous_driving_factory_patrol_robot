import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { errMessage } from '../../live/errors.ts'
import { displayName } from '../../live/robotName.ts'
import {
  fetchOverheatRanking, fetchAlertsWeekly, fetchBatteryEstimate,
  formatMinutes, estimateNote, dayLabel,
} from '../../live/statsMetrics.ts'
import type { OverheatRanking, AlertsWeekly, BatteryEstimate } from '../../live/contracts.d.ts'

// 통계 지표 3종 (S15P11E101-768)
//
// 셋 다 '숫자를 보여 준다' 가 아니라 '무엇을 할지 정한다' 를 위한 화면이다.
//   과열 랭킹 : 어느 설비를 먼저 점검할까
//   주간 추이 : 지금이 평소보다 많은가
//   배터리   : 오늘 밤을 넘길 수 있는가
// 그래서 숫자 옆에 늘 근거(마지막 발생 시각·기간·소모율)를 함께 둔다.

const DAYS = 7

// 로컬 시각으로 '08-06 14:12'. 마지막 발생 시각은 날짜까지 있어야 쓸모 있다 —
// '어제 밤' 과 '방금' 은 점검 순서를 바꾼다.
const whenText = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function MetricsPanel() {
  const { enabled, robotId } = useLive()
  const { accessToken } = useAuth()
  const [rank, setRank] = useState<OverheatRanking | null>(null)
  const [weekly, setWeekly] = useState<AlertsWeekly | null>(null)
  const [batt, setBatt] = useState<BatteryEstimate | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true); setErr(null)
    // 셋을 나란히 부른다. 하나가 늦다고 나머지를 붙잡아 둘 이유가 없다.
    const [r, w, b] = await Promise.allSettled([
      fetchOverheatRanking(DAYS, accessToken),
      fetchAlertsWeekly(DAYS, accessToken),
      fetchBatteryEstimate(robotId, accessToken),
    ])
    if (r.status === 'fulfilled') setRank(r.value)
    if (w.status === 'fulfilled') setWeekly(w.value)
    if (b.status === 'fulfilled') setBatt(b.value)
    // 하나라도 실패하면 말한다. 조용히 비워 두면 '경보가 없다' 로 잘못 읽힌다.
    const bad = [r, w, b].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
    if (bad) setErr(errMessage(bad.reason))
    setLoading(false)
  }, [enabled, accessToken, robotId])

  useEffect(() => { load() }, [load])

  const maxDay = Math.max(1, ...(weekly?.items || []).map((d) => d.total))
  const topCount = Math.max(1, ...(rank?.items || []).map((d) => d.count))
  const note = estimateNote(batt)

  return (
    <div className="card-v3" id="pMetrics">
      <h3>
        운영 지표 <span className="k">MAINTENANCE · TREND · ENDURANCE</span>
        {enabled && (
          <button type="button" className="btn-tonal" onClick={load} disabled={loading}
            style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: '12px' }}>
            {loading ? '조회 중…' : '새로고침'}
          </button>
        )}
      </h3>

      {!enabled && (
        <div className="cfg-note">시뮬레이션 모드에서는 집계되지 않습니다. 실서버 모드로 로그인하세요.</div>
      )}
      {err && <div className="form-msg err">지표를 불러오지 못했습니다 — {err}</div>}

      {enabled && (
        <div className="metric-grid">
          {/* ① 어느 설비를 먼저 점검할까 */}
          <section className="metric" aria-label="설비별 과열 랭킹">
            <div className="metric-head">
              <b>설비별 과열</b>
              <span className="k">최근 {rank?.periodDays ?? DAYS}일 · {rank?.totalCount ?? 0}건</span>
            </div>
            {!rank?.items?.length
              ? <p className="cfg-help">과열 이력이 없습니다.</p>
              : (
                <ul className="rankbars">
                  {rank.items.slice(0, 5).map((it) => (
                    <li key={it.equipmentId}>
                      <div className="rankbar-top">
                        <b>{it.name}</b>
                        <span className="mono">{it.count}건</span>
                      </div>
                      <div className="rankbar"><i style={{ width: `${(it.count / topCount) * 100}%` }} /></div>
                      {/* 언제 마지막이었는지가 점검 순서를 바꾼다 */}
                      <span className="rankbar-when mono">마지막 {whenText(it.lastAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          {/* ② 지금이 평소보다 많은가 */}
          <section className="metric" aria-label="주간 경보 추이">
            <div className="metric-head">
              <b>주간 경보 추이</b>
              <span className="k">최근 {weekly?.periodDays ?? DAYS}일</span>
            </div>
            {!weekly?.items?.length
              ? <p className="cfg-help">집계된 경보가 없습니다.</p>
              : (
                <>
                  <ul className="weekbars">
                    {weekly.items.map((d) => (
                      <li key={d.date} title={`${d.date} · 화재 ${d.fire} · 과열 ${d.overheat}`}>
                        {/* 0 인 날도 자리를 지킨다 — 빠지면 추이가 아니라 목록이 된다 */}
                        <div className="weekbar">
                          <i className="fire" style={{ height: `${(d.fire / maxDay) * 100}%` }} />
                          <i className="heat" style={{ height: `${(d.overheat / maxDay) * 100}%` }} />
                        </div>
                        <span className="weekbar-day mono">{dayLabel(d.date)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="metric-legend">
                    <span><i className="sw fire" />화재</span>
                    <span><i className="sw heat" />과열</span>
                  </div>
                </>
              )}
          </section>

          {/* ③ 오늘 밤을 넘길 수 있는가 */}
          <section className="metric" aria-label="배터리 잔여 가동시간">
            <div className="metric-head">
              <b>배터리</b>
              <span className="k">{displayName(batt?.robotId || robotId)}</span>
            </div>
            <div className="metric-big mono">
              {batt?.battery == null ? '—' : `${Math.round(batt.battery)}`}
              {batt?.battery != null && <span className="unit">%</span>}
            </div>
            <div className="kv"><span>소모 추세</span><b className="num">
              {batt?.dischargePerHour == null ? '—' : `${batt.dischargePerHour} %/h`}
            </b></div>
            <div className="kv"><span>예상 잔여 가동</span><b className="num">
              {formatMinutes(batt?.estimatedRemainingMinutes)}
            </b></div>
            {/* 왜 모르는지가 '모른다' 보다 쓸모 있다 */}
            {note && <p className="cfg-help">{note}</p>}
          </section>
        </div>
      )}
    </div>
  )
}
