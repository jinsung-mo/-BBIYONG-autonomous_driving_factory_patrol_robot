import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import { isFloorplan } from '../../live/floorplan.ts'
import MappingProgress from './MappingProgress.tsx'
import LiveNavMap from './LiveNavMap.tsx'
import IsoMapView from './IsoMapView.tsx'

const ZOOM_MIN = 0.7
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.2
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))))

// 지도 탭 (S15P11E101-744).
//
// 매핑 진행 상태에 따라 보여 줄 것이 완전히 달라진다.
//   매핑 중        : 아직 도면이 없다 — 진행 안내를 띄운다
//   도면 있음      : 3D 압출 도면(S15P11E101-676)
//   도면 없음·IDLE : 무엇을 해야 하는지 알려 준다
//
// 실시간 SLAM 점유격자는 운영 탭 전용이다. 매핑이 도는 동안 여기에 격자를 흘리면
// '지금 보고 있는 것이 확정된 지도' 라고 오해하게 된다 — 그 지도는 아직 그리는 중이다.
export default function MapPanel() {
  const { refs } = useSim()
  const { enabled, telemetry, plan, mapping } = useLive()
  const mapDown = enabled && isDown(capOf(telemetry, CAP_KEYS.map))

  // 정제 도면이 있으면 입체로 보여 준다(S15P11E101-676). 없으면 볼 것이 없으므로 2D 다.
  //
  // 2D 를 없애지 않고 한 번의 클릭 거리에 둔다 — 입체는 구역이 한눈에 들어오지만
  // 정확한 위치를 읽는 데는 위에서 내려다보는 편이 낫다. 조작자가 고를 일이다.
  const canIso = enabled && isFloorplan(plan)
  // 매핑 중에는 도면을 내주지 않는다. 직전 도면이 남아 있어도 지금 구조와 다를 수 있다.
  const showMapping = enabled && mapping
  // 매핑도 아니고 도면도 없으면 그릴 것이 없다 — 빈 검은 판 대신 할 일을 적어 준다.
  const showEmpty = enabled && !mapping && !plan
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
        {enabled && showMapping ? <MappingProgress />
          : enabled && showEmpty ? (
            <div className="map-empty" role="status">
              <b>아직 활성 도면이 없습니다</b>
              <span>운영 탭에서 매핑을 시작하면 도면이 만들어집니다.</span>
            </div>
          )
          : enabled
          ? (showIso ? <IsoMapView zoomFactor={zoom} /> : <LiveNavMap zoomFactor={zoom} planOnly />)
          : <canvas
              ref={refs.map2d}
              className="map-zoom-canvas"
              style={{ transform: `scale(${zoom})` }}
            />}
        {canIso && !showMapping && (
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
        {mapDown && !showMapping && <span className="nodata">SLAM 맵 데이터 없음</span>}
        {!showMapping && !showEmpty && <div className="maplegend" aria-label="지도 범례">
          <span><i className="legend-mark robot" />오린카</span>
          <span><i className="legend-mark route" />순찰 경로</span>
          <span><i className="legend-mark switchboard" />분전반</span>
          <span><i className="legend-mark fire" />화재 지점</span>
          <span><i className="legend-mark obstacle" />장애물</span>
        </div>}
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
