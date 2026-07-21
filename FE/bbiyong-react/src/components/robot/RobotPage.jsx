import { useSim } from '../../SimContext.js'
import StatusPanel from './StatusPanel.jsx'
import ControlPanel from './ControlPanel.jsx'
import MapPanel from './MapPanel.jsx'

// 화면 4 · 순찰 로봇 관제 (다크 테마)
export default function RobotPage({ active }) {
  const { status, refs } = useSim()
  return (
    <section id="pgB" className={`page${active ? ' on' : ''}`}>
      <div className="b-grid">
        <StatusPanel />

        <div className="panel" id="pCam">
          <h3>순찰 로봇 카메라 <span className="k">FRONT · YOLOv8</span></h3>
          <div className="vwrap">
            <canvas ref={refs.rcam} />
            <span className="hud">{status.rcamHud}</span>
            <span className="rec">● REC 00:00</span>
          </div>
        </div>

        <ControlPanel />

        {/* 우측 열: 열화상 + 2D 맵을 50/50 동일 높이로 분할 */}
        <div className="b-right">
          <div className="panel" id="pThermal">
            <h3>순찰 로봇 열화상 카메라 <span className="k">THERMAL</span></h3>
            <div className="vwrap">
              <canvas ref={refs.tcam} />
              <span className="hud2" style={{ color: status.thermalColor }}>{status.thermalMax}</span>
            </div>
          </div>
          <MapPanel />
        </div>
      </div>
    </section>
  )
}
