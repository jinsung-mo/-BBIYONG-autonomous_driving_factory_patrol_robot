import { useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import { isFloorplan } from '../../live/floorplan.ts'
import LiveNavMap from './LiveNavMap.tsx'
import IsoMapView from './IsoMapView.tsx'

// 2D 맵핑 지도 (SLAM · LiDAR)
// live 모드에서는 시뮬 맵 대신 로봇이 보내는 실제 SLAM 맵을 그린다(S15P11E101-450).
export default function MapPanel() {
  const { refs } = useSim()
  const { enabled, telemetry, plan } = useLive()
  const mapDown = enabled && isDown(capOf(telemetry, CAP_KEYS.map))

  // 정제 도면이 있으면 입체로 보여 준다(S15P11E101-676). 없으면 볼 것이 없으므로 2D 다.
  //
  // 2D 를 없애지 않고 한 번의 클릭 거리에 둔다 — 입체는 구역이 한눈에 들어오지만
  // 정확한 위치를 읽는 데는 위에서 내려다보는 편이 낫다. 조작자가 고를 일이다.
  const canIso = enabled && isFloorplan(plan)
  const [iso, setIso] = useState(true)
  // 도면이 사라지면(원본만 남으면) 2D 로 돌아가야 한다 — 빈 입체 화면을 남기지 않는다
  useEffect(() => { if (!canIso) setIso(false); else setIso(true) }, [canIso])
  const showIso = canIso && iso

  return (
    <div className="panel" id="pMap">
      <div className={`vwrap${mapDown ? ' down' : ''}`} style={{ background: '#0a0c10' }}>
        {enabled
          ? (showIso ? <IsoMapView /> : <LiveNavMap />)
          : <canvas ref={refs.map2d} />}
        {canIso && (
          <button
            type="button"
            className="mapview mapdim"
            onClick={() => setIso((v) => !v)}
            aria-pressed={iso}
            title={iso ? '위에서 내려다보기' : '입체로 보기'}
          >
            {iso ? '입체' : '평면'}
          </button>
        )}
        {mapDown && <span className="nodata">SLAM 맵 데이터 없음</span>}
        <div className="maplegend" aria-label="지도 범례">
          <span><i className="legend-mark robot" />오린카</span>
          <span><i className="legend-mark route" />순찰 경로</span>
          <span><i className="legend-mark switchboard" />분전반</span>
          <span><i className="legend-mark fire" />화재 지점</span>
          <span><i className="legend-mark obstacle" />장애물</span>
        </div>
      </div>
    </div>
  )
}
