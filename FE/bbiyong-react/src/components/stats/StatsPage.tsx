import KpiRow from '../robot/KpiRow.tsx'
import DashboardStatsPanel from './DashboardStatsPanel.tsx'
import EventStatsPanel from '../ops/EventStatsPanel.tsx'
import HealthPanel from '../ops/HealthPanel.tsx'

export default function StatsPage() {
  return (
    <section id="pgStats" className="page on sim-skin nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>통계 분석</h2>
          <span className="nav-sub">STATISTICS & ANALYTICS · DASHBOARD METRICS</span>
        </div>
        <KpiRow />
      </div>

      <div className="nav-stage">
        <div className="nav-canvas" style={{ width: '100%' }}>
          <div className="stats-page-grid" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <DashboardStatsPanel />
            <EventStatsPanel />
            <HealthPanel />
          </div>
        </div>
      </div>
    </section>
  )
}
