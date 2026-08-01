import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { fetchDashboardStats, count, pct } from '../../live/dashboard.ts'
import { errMessage } from '../../live/errors.ts'

// 관제 상단 요약 띠 — GET /api/dashboard/stats
//
// 텔레메트리는 지금 이 순간의 로봇 한 대만 말해 준다. 편성 전체의 대수와
// 오늘 누적 이벤트는 서버 집계로만 알 수 있어서 이 줄이 필요하다.
//
// 30초마다 다시 받는다(가이드 권장). 실시간 경보는 STOMP 로 이미 즉시 들어오므로
// 이 값이 몇 초 늦는 것은 문제가 되지 않는다 — 더 자주 부르면 서버만 바쁘다.
const REFRESH_MS = 30000

export default function SummaryBar() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()

  const [stats, setStats] = useState<import('../../live/contracts.d.ts').DashboardStats | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    try {
      const res = await fetchDashboardStats(accessToken)
      if (!alive.current) return
      setStats(res); setErr(null)
    } catch (e) {
      // 갱신 실패로 직전 값을 지우지 않는다 — 낡은 수치가 빈 칸보다 낫고, 낡았다는 것은 문구로 알린다.
      if (alive.current) setErr(errMessage(e))
    }
  }, [enabled, accessToken])

  useEffect(() => {
    load()
    if (!enabled || !accessToken) return undefined
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load, enabled, accessToken])

  // 시뮬레이션 모드에는 서버 집계가 없다. 빈 카드를 띄우느니 줄 자체를 내보내지 않는다.
  if (!enabled) return null
  if (!stats && !err) return null

  const s = stats?.summary
  const t = stats?.today

  return (
    <div className="sumbar" id="pSummary">
      <div className="sumcard">
        <span>가동 중 로봇</span>
        <b className="num">{count(s?.activeRobots)}<i>/ {count(s?.totalRobots)}</i></b>
      </div>
      <div className="sumcard">
        <span>온라인</span>
        <b className="num">{count(s?.onlineRobots)}<i>대</i></b>
      </div>
      <div className="sumcard">
        <span>충전 중</span>
        <b className="num">{count(s?.chargingRobots)}<i>대</i></b>
      </div>
      <div className="sumcard">
        <span>평균 배터리</span>
        <b className="num">{pct(s?.avgBattery)}</b>
      </div>
      <div className="sumcard">
        <span>오늘 이벤트</span>
        <b className="num">{count(t?.eventCount)}<i>건</i></b>
      </div>
      {/* 긴급·미해결은 0이 아닐 때만 색으로 끌어올린다 — 평소에 빨간 숫자가 상주하면 무뎌진다 */}
      <div className={`sumcard${(t?.criticalEvents ?? 0) > 0 ? ' hot' : ''}`}>
        <span>오늘 긴급</span>
        <b className="num">{count(t?.criticalEvents)}<i>건</i></b>
      </div>
      <div className={`sumcard${(t?.unresolvedEvents ?? 0) > 0 ? ' warn' : ''}`}>
        <span>미해결</span>
        <b className="num">{count(t?.unresolvedEvents)}<i>건</i></b>
      </div>
      {err && <div className="sumerr" title={err}>집계 갱신 실패 — 표시된 값은 최신이 아닐 수 있습니다.</div>}
    </div>
  )
}
