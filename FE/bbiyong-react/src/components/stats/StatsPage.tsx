import KpiRow from '../robot/KpiRow.tsx'
import DashboardStatsPanel from './DashboardStatsPanel.tsx'
import MetricsPanel from './MetricsPanel.tsx'
import EventStatsPanel from '../ops/EventStatsPanel.tsx'
import HealthPanel from '../ops/HealthPanel.tsx'

export default function StatsPage() {
  return (
    <section id="pgStats" className="page on v3-theme nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>통계 분석</h2>
          <span className="nav-sub">STATISTICS & ANALYTICS · DASHBOARD METRICS</span>
        </div>
        <KpiRow />
      </div>

      <div className="nav-stage">
        <div className="nav-canvas" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', alignContent: 'start', height: '100%', overflow: 'auto' }}>
            <div style={{ gridColumn: 'span 2' }}>
              <DashboardStatsPanel />
            </div>
            {/* 무엇을 할지 정하는 지표 3종(S15P11E101-768) — 요약 바로 아래 둔다 */}
            <div style={{ gridColumn: 'span 2' }}>
              <MetricsPanel />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <EventStatsPanel />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <HealthPanel />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
