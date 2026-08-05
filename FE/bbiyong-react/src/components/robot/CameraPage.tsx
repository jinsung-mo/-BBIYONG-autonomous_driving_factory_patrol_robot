import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import ControlPanel from './ControlPanel.tsx'
import EventLog from './EventLog.tsx'
import KpiRow from './KpiRow.tsx'

const ZOOM_MIN = 1
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.2
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))))

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
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  // 어느 판을 크게 볼지. 화재를 의심할 때는 열이 오르는 자리를 크게 봐야 한다.
  const [swapped, setSwapped] = useState(false)

  const camDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.camera)) || !videoSeen.FRONT)
  const thermalDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.thermal)) || !videoSeen.THERMAL)

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

  // 자리를 바꾸면 배율은 1 로 되돌린다 — 방금 전 판에 걸어 둔 배율이
  // 새로 커진 판에 그대로 얹히면 엉뚱한 곳이 잘려 보인다.
  const swap = useCallback(() => {
    setSwapped((current) => !current)
    setZoom(1)
  }, [])
  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => clampZoom(current + delta))
  }, [])
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === document.documentElement) await document.exitFullscreen()
      else if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    } catch { /* 브라우저가 전체화면을 막으면 현재 화면을 유지한다. */ }
  }, [])

  return (
    <section id="pgCam" className="page on sim-skin nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>순찰 카메라 뷰</h2>
          <span className="nav-sub">FRONT · THERMAL</span>
        </div>
        <KpiRow />
      </div>

      <div className="cam-stage">
        <aside className="panel cam-side-panel" aria-label="순찰 로봇 수동 조작 및 이벤트 로그">
          <ControlPanel />
          <EventLog />
        </aside>

        <div className="cam-main">
          {/* 크게 보는 판과 겹쳐 띄우는 판은 id 가 아니라 .pip 유무로 갈린다.
              더블클릭하면 둘이 자리를 바꾼다 — 열을 확인해야 할 때는 열화상이 커야 한다. */}
          <div
            className={`panel${swapped ? ' pip' : ''}`}
            id="pCam"
            onDoubleClick={swapped ? swap : undefined}
            title={swapped ? '더블클릭하면 크게 봅니다' : undefined}
          >
            <div className={`vwrap${camDown ? ' down' : ''}`}>
              <canvas
                ref={refs.rcam}
                className="camera-zoom-canvas"
                style={{ transform: `scale(${swapped ? 1 : zoom})` }}
              />
              <span className="hud">{status.rcamHud}</span>
              <span className="rec">● REC 00:00</span>
              {camDown && <span className="nodata">전면 카메라 영상 없음</span>}
            </div>
          </div>

          <div
            className={`panel${swapped ? '' : ' pip'}`}
            id="pThermal"
            onDoubleClick={swapped ? undefined : swap}
            title={swapped ? undefined : '더블클릭하면 크게 봅니다'}
          >
            <div className={`vwrap${thermalDown ? ' down' : ''}`}>
              <canvas
                ref={refs.tcam}
                className="camera-zoom-canvas"
                style={{ transform: `scale(${swapped ? zoom : 1})` }}
              />
              {!thermalDown && (
                <span className="hud2" style={{ color: status.thermalColor }}>{status.thermalMax}</span>
              )}
              {thermalDown && <span className="nodata">열화상 미탑재 — 데이터 없음</span>}
            </div>
          </div>

          {/* 확대·전체화면은 지금 크게 보고 있는 판에 걸린다. 판을 바꿔도 버튼 자리는
              그대로다 — 손이 가는 자리가 움직이면 급할 때 헛손질이 난다. */}
          <div className="map-controls camera-controls" aria-label="카메라 화면 조절">
            <button
              type="button"
              className="map-control zoom-in"
              onClick={() => changeZoom(ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX}
              aria-label="카메라 확대"
              title="카메라 확대"
            >+</button>
            <button
              type="button"
              className="map-control zoom-out"
              onClick={() => changeZoom(-ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN}
              aria-label="카메라 축소"
              title="카메라 축소"
            >−</button>
            <button
              type="button"
              className="map-control fullscreen"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? '전체화면 종료' : '카메라 전체화면'}
              aria-pressed={fullscreen}
              title={fullscreen ? '전체화면 종료 (Esc)' : '카메라 전체화면'}
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
    </section>
  )
}
