import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import ControlPanel from './ControlPanel.tsx'
import EventLog from './EventLog.tsx'
import CapBadge from './CapBadge.tsx'

// 카메라 화면 (시뮬레이션 전용).
//
// 좌측 위에 수동 조작, 그 아래 이벤트 로그, 우측은 전면 카메라 하나로 채운다.
// 눈으로 보면서 모는 일이라 손이 가는 조작은 화면 가장자리(좌측)에 고정해 두고,
// 봐야 하는 영상은 가장 넓은 자리를 준다 — 시선은 영상에, 손은 늘 같은 자리에.
//
// 열화상은 전면 위에 겹쳐 작게 띄운다. 화재를 의심할 때 전면만 봐서는 판단이
// 반쪽이다 — 불꽃이 보이는 자리와 열이 오르는 자리를 눈을 옮기지 않고 같이 본다.
// 겹치는 만큼 테두리와 그림자를 남긴다. 영상 위의 영상은 경계가 없으면 한 장면으로 읽힌다.
export default function CameraPage() {
  const { status, refs } = useSim()
  const { enabled, telemetry, videoSeen } = useLive()

  const camDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.camera)) || !videoSeen.FRONT)
  const thermalDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.thermal)) || !videoSeen.THERMAL)

  return (
    <section id="pgCam" className="page on sim-skin nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>순찰 로봇 카메라</h2>
          <span className="nav-sub">FRONT · THERMAL</span>
        </div>
      </div>

      <div className="cam-stage">
        <ControlPanel />
        <EventLog />

        <div className="cam-main">
          <div className="panel" id="pCam">
            <h3>
              전면 카메라 <span className="k">FRONT · YOLOv11n</span>
              <CapBadge capKey={CAP_KEYS.camera} />
            </h3>
            <div className={`vwrap${camDown ? ' down' : ''}`}>
              <canvas ref={refs.rcam} />
              <span className="hud">{status.rcamHud}</span>
              <span className="rec">● REC 00:00</span>
              {camDown && <span className="nodata">전면 카메라 영상 없음</span>}
            </div>
          </div>

          <div className="panel pip" id="pThermal">
            <h3>
              열화상 <span className="k">THERMAL</span>
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
        </div>
      </div>
    </section>
  )
}
