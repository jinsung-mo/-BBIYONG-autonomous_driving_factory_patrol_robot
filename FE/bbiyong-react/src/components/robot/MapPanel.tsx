import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import { isFloorplan } from '../../live/floorplan.ts'
import LiveNavMap from './LiveNavMap.tsx'
import IsoMapView from './IsoMapView.tsx'

const ZOOM_MIN = 0.7
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.2
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))))

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
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  // 도면이 사라지면(원본만 남으면) 2D 로 돌아가야 한다 — 빈 입체 화면을 남기지 않는다
  useEffect(() => { if (!canIso) setIso(false); else setIso(true) }, [canIso])
  const showIso = canIso && iso

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === document.documentElement
      setFullscreen(active)
      document.documentElement.classList.toggle('view-fullscreen', active)
    }
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      document.documentElement.classList.remove('view-fullscreen')
    }
  }, [])

  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => clampZoom(current + delta))
  }, [])
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === document.documentElement) await document.exitFullscreen()
      else if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    } catch { /* 브라우저가 전체화면을 막으면 현재 화면을 유지한다 */ }
  }, [])

  return (
    <div className="panel" id="pMap">
      <div className={`vwrap${mapDown ? ' down' : ''}`} style={{ background: '#0a0c10' }}>
        {enabled
          ? (showIso ? <IsoMapView zoomFactor={zoom} /> : <LiveNavMap zoomFactor={zoom} />)
          : <canvas
              ref={refs.map2d}
              className="map-zoom-canvas"
              style={{ transform: `scale(${zoom})` }}
            />}
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
        <div className="map-controls" aria-label="지도 화면 조절">
          <button
            type="button"
            className="map-control zoom-in"
            onClick={() => changeZoom(ZOOM_STEP)}
            disabled={zoom >= ZOOM_MAX}
            aria-label="지도 확대"
            title="지도 확대"
          >+</button>
          <button
            type="button"
            className="map-control zoom-out"
            onClick={() => changeZoom(-ZOOM_STEP)}
            disabled={zoom <= ZOOM_MIN}
            aria-label="지도 축소"
            title="지도 축소"
          >−</button>
          <button
            type="button"
            className="map-control fullscreen"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? '전체화면 종료' : '지도 전체화면'}
            aria-pressed={fullscreen}
            title={fullscreen ? '전체화면 종료 (Esc)' : '지도 전체화면'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {fullscreen
                ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                : <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />}
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
