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
    <div className="nx-card" id="pDashboardStats">
      <div className="nx-card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>관제 대시보드 종합 통계 <span className="k">DASHBOARD SUMMARY</span></h3>
        {enabled && (
          <button type="button" className="basebtn" onClick={load} disabled={loading} style={{ padding: '4px 12px', fontSize: '12px' }}>
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
        <div className="stats-summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginTop: '14px' }}>
          <div className="stat-card" style={{ padding: '14px', borderRadius: '12px', background: 'var(--nx-elev, #ffffff)', border: '1px solid var(--nx-divider, #e1e7ec)' }}>
            <div style={{ fontSize: '12px', color: 'var(--nx-muted, #718096)' }}>총 순찰 로봇</div>
            <div style={{ fontSize: '24px', fontWeight: 600, marginTop: '4px' }}>{count(s?.totalRobots)} <span style={{ fontSize: '13px' }}>대</span></div>
            <div style={{ fontSize: '11px', color: '#3ddc97', marginTop: '4px' }}>가동 중 {count(s?.activeRobots)}대 · 온라인 {count(s?.onlineRobots)}대</div>
          </div>

          <div className="stat-card" style={{ padding: '14px', borderRadius: '12px', background: 'var(--nx-elev, #ffffff)', border: '1px solid var(--nx-divider, #e1e7ec)' }}>
            <div style={{ fontSize: '12px', color: 'var(--nx-muted, #718096)' }}>오늘 이벤트 발생</div>
            <div style={{ fontSize: '24px', fontWeight: 600, marginTop: '4px' }}>{count(t?.eventCount)} <span style={{ fontSize: '13px' }}>건</span></div>
            <div style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px' }}>긴급 {count(t?.criticalEvents)}건 · 미해결 {count(t?.unresolvedEvents)}건</div>
          </div>

          <div className="stat-card" style={{ padding: '14px', borderRadius: '12px', background: 'var(--nx-elev, #ffffff)', border: '1px solid var(--nx-divider, #e1e7ec)' }}>
            <div style={{ fontSize: '12px', color: 'var(--nx-muted, #718096)' }}>관제 대상 설비</div>
            <div style={{ fontSize: '24px', fontWeight: 600, marginTop: '4px' }}>{count(eq?.totalEquipments)} <span style={{ fontSize: '13px' }}>개</span></div>
            <div style={{ fontSize: '11px', color: eq?.overheatingEquipments ? '#ff6b6b' : '#3ddc97', marginTop: '4px' }}>
              {eq?.overheatingEquipments ? `과열 ${eq.overheatingEquipments}개 감지` : '정상 작동 중'}
            </div>
          </div>

          <div className="stat-card" style={{ padding: '14px', borderRadius: '12px', background: 'var(--nx-elev, #ffffff)', border: '1px solid var(--nx-divider, #e1e7ec)' }}>
            <div style={{ fontSize: '12px', color: 'var(--nx-muted, #718096)' }}>평균 배터리 잔량</div>
            <div style={{ fontSize: '24px', fontWeight: 600, marginTop: '4px' }}>{pct(s?.avgBattery)}</div>
            <div style={{ fontSize: '11px', color: 'var(--nx-muted, #718096)', marginTop: '4px' }}>충전 중 {count(s?.chargingRobots)}대</div>
          </div>
        </div>
      )}
    </div>
  )
}
