import { useCallback, useEffect, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { fetchDashboardStats, count, pct } from '../../live/dashboard.ts'
import { errMessage } from '../../live/errors.ts'

export default function DashboardStatsPanel() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()
  const [data, setData] = useState<import('../../live/contracts.d.ts').DashboardStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDashboardStats(accessToken)
      setData(res)
    } catch (e) {
      setErr(errMessage(e))
    } finally {
      setLoading(false)
    }
  }, [enabled, accessToken])

  useEffect(() => {
    load()
  }, [load])

  const s = data?.summary
  const t = data?.today
  const eq = data?.equipment

  return (
    <div className="card-v3" id="pDashboardStats">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ margin: 0 }}>관제 대시보드 종합 통계 <span className="k">DASHBOARD SUMMARY</span></h3>
        {enabled && (
          <button type="button" className="btn-tonal" onClick={load} disabled={loading} style={{ padding: '4px 12px', fontSize: '12px' }}>
            {loading ? '조회 중…' : '새로고침'}
          </button>
        )}
      </div>
      <p className="cfg-help">
        관제 시스템 전체의 순찰 로봇 가동 현황, 오늘 발생한 이벤트 집계 및 설비 상태 요약입니다.
      </p>

      {!enabled && (
        <div className="cfg-note">
          시뮬레이션 모드에서는 종합 통계가 조회되지 않습니다. 실서버 모드로 로그인하세요.
        </div>
      )}

      {err && <div className="form-msg err">대시보드 통계를 불러오지 못했습니다 — {err}</div>}

      {enabled && !err && (
        <div className="sumbar" style={{ marginTop: '14px' }}>
          <div className="sumcard">
            <span>총 순찰 로봇</span>
            <b>{count(s?.totalRobots)} <i>대</i></b>
            <div style={{ fontSize: '11px', color: '#74A98D', marginTop: '4px' }}>가동 중 {count(s?.activeRobots)}대 · 온라인 {count(s?.onlineRobots)}대</div>
          </div>

          <div className="sumcard">
            <span>오늘 이벤트 발생</span>
            <b>{count(t?.totalEvents)} <i>건</i></b>
            <div style={{ fontSize: '11px', color: '#C07A72', marginTop: '4px' }}>긴급 {count(t?.criticalEvents)}건 · 미해결 {count(t?.unresolvedEvents)}건</div>
          </div>

          <div className={`sumcard ${eq?.overheatingEquipments ? 'hot' : ''}`}>
            <span>관제 대상 설비</span>
            <b>{count(eq?.totalEquipments)} <i>개</i></b>
            <div style={{ fontSize: '11px', color: eq?.overheatingEquipments ? '#C07A72' : '#74A98D', marginTop: '4px' }}>
              {eq?.overheatingEquipments ? `과열 ${eq.overheatingEquipments}개 감지` : '정상 작동 중'}
            </div>
          </div>

          <div className="sumcard">
            <span>평균 배터리 잔량</span>
            <b>{pct(s?.avgBattery)}</b>
            <div style={{ fontSize: '11px', color: '#7C8296', marginTop: '4px' }}>충전 중 {count(s?.chargingRobots)}대</div>
          </div>
        </div>
      )}
    </div>
  )
}
