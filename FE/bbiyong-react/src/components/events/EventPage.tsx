import KpiRow from '../robot/KpiRow.tsx'
import LogList from '../LogList.tsx'

export default function EventPage() {
  return (
    <section id="pgEvents" className="page on sim-skin nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>이벤트 로그</h2>
          <span className="nav-sub">EVENT ARCHIVE · REALTIME ALERTS</span>
        </div>
        <KpiRow />
      </div>

      <div className="nav-stage">
        <div className="nav-canvas" style={{ width: '100%' }}>
          <div className="panel event-page-panel" style={{ padding: '24px' }}>
            <LogList variant="elog full-elog" simple={false} />
          </div>
        </div>
      </div>
    </section>
  )
}
