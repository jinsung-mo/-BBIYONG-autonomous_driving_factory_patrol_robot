import LogList from '../LogList.tsx'

export default function EventPage() {
  return (
    <section id="pgEvents" className="page on v3-theme nav-page">
      <div className="nav-stage">
        <div className="nav-canvas" style={{ gridColumn: '1 / -1', minHeight: 0 }}>
          <LogList variant="elog full-elog" simple={false} />
        </div>
      </div>
    </section>
  )
}
