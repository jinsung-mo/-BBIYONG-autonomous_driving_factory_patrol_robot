import { useSim } from '../../SimContext.js'
import { useLive } from '../../live/LiveContext.jsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.js'
import StatusPanel from './StatusPanel.jsx'
import ControlPanel from './ControlPanel.jsx'
import MapPanel from './MapPanel.jsx'
import CapBadge from './CapBadge.jsx'

// 순찰 로봇 관제 (다크 테마) — 단일 화면
export default function RobotPage() {
  const { status, refs } = useSim()
  const { enabled, telemetry, videoSeen } = useLive()

  // live 모드에서 로봇 서브시스템이 죽어 있거나 프레임이 한 번도 오지 않았으면
  // 그 패널을 흐리게 하고 안내를 덮는다. 캔버스에는 시뮬 화면이 남아 있어서,
  // 덮지 않으면 목업이 실데이터로 보인다 — 이번 작업의 핵심이다(S15P11E101-462).
  // 열화상은 로봇이 아예 생산하지 않아 항상 여기에 해당한다.
  const camDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.camera)) || !videoSeen.FRONT)
  const thermalDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.thermal)) || !videoSeen.THERMAL)

  return (
    <section id="pgB" className="page on">
      <div className="b-grid">
        <StatusPanel />

        <div className="panel" id="pCam">
          <h3>
            순찰 로봇 카메라 <span className="k">FRONT · YOLOv11n</span>
            <CapBadge capKey={CAP_KEYS.camera} />
          </h3>
          <div className={`vwrap${camDown ? ' down' : ''}`}>
            <canvas ref={refs.rcam} />
            <span className="hud">{status.rcamHud}</span>
            <span className="rec">● REC 00:00</span>
            {camDown && <span className="nodata">전면 카메라 영상 없음</span>}
          </div>
        </div>

        <ControlPanel />

        {/* 우측 열: 열화상 + 2D 맵을 50/50 동일 높이로 분할 */}
        <div className="b-right">
          <div className="panel" id="pThermal">
            <h3>
              순찰 로봇 열화상 카메라 <span className="k">THERMAL</span>
              <CapBadge capKey={CAP_KEYS.thermal} />
            </h3>
            <div className={`vwrap${thermalDown ? ' down' : ''}`}>
              <canvas ref={refs.tcam} />
              {!thermalDown && (
                <span className="hud2" style={{ color: status.thermalColor }}>{status.thermalMax}</span>
              )}
              {thermalDown && <span className="nodata">열화상 미탑재 — 데이터 없음</span>}
            </div>
          </div>
          <MapPanel />
        </div>
      </div>
    </section>
  )
}
