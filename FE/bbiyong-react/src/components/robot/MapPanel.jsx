// @ts-check
import { useSim } from '../../SimContext.js'
import { useLive } from '../../live/LiveContext.jsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.js'
import LiveNavMap from './LiveNavMap.jsx'
import CapBadge from './CapBadge.jsx'

// 2D 맵핑 지도 (SLAM · LiDAR)
// live 모드에서는 시뮬 맵 대신 로봇이 보내는 실제 SLAM 맵을 그린다(S15P11E101-450).
export default function MapPanel() {
  const { refs } = useSim()
  const { enabled, telemetry } = useLive()
  const mapDown = enabled && isDown(capOf(telemetry, CAP_KEYS.map))

  return (
    <div className="panel" id="pMap">
      <h3>
        2D 맵핑 지도 <span className="k">SLAM · LiDAR</span>
        <CapBadge capKey={CAP_KEYS.map} />
      </h3>
      <div className={`vwrap${mapDown ? ' down' : ''}`} style={{ background: '#0a0c10' }}>
        {enabled ? <LiveNavMap /> : <canvas ref={refs.map2d} />}
        {mapDown && <span className="nodata">SLAM 맵 데이터 없음</span>}
      </div>
      <div className="maplegend">
        {enabled ? (
          <>
            <span><i style={{ background: '#f0c98a' }} />로봇 · 궤적</span>
            <span><i style={{ background: '#7aa2d2' }} />LiDAR 스캔</span>
            <span><i style={{ background: '#141414' }} />벽</span>
            <span><i style={{ background: '#f5f5f5' }} />자유 공간</span>
            <span><i style={{ background: '#3c3c3c' }} />미탐색</span>
          </>
        ) : (
          <>
            <span><i style={{ background: '#3ddc97' }} />오린카</span>
            <span><i style={{ background: '#3f8fe0' }} />순찰 경로</span>
            <span><i style={{ background: '#f5a623' }} />분전반</span>
            <span><i style={{ background: '#ff5648' }} />화재 지점</span>
            <span><i style={{ background: '#59637a' }} />장애물(SLAM)</span>
          </>
        )}
      </div>
    </div>
  )
}
