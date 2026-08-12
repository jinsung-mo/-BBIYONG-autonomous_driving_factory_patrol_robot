import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import ControlPanel from './ControlPanel.tsx'
import HlsVideo from './HlsVideo.tsx'
import type { HlsHealth } from './HlsVideo.tsx'

const ZOOM_MIN = 1
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.2
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))))

// 카메라 화면 (시뮬레이션 전용).
//
// 좌측에 수동 조작, 우측은 전면 카메라 하나로 채운다(이벤트 로그는 지도 화면으로 옮겼다).
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

  // 🔴 [2026-08-12] 전면 카메라의 '영상 없음' 판정을 videoSeen.FRONT 에서 HLS 재생 상태로
  //    바꾼다. 영상이 WebSocket 을 떠났으므로 `videoSeen.FRONT` 는 **영원히 false** 가 됐고,
  //    그대로 두면 HLS 가 멀쩡히 재생되는 동안에도 "전면 카메라 영상 없음" 이 계속 떠 있다.
  //    열화상은 여전히 WS 로 오므로 videoSeen.THERMAL 은 그대로 쓴다.
  const [hlsHealth, setHlsHealth] = useState<HlsHealth>('loading')

  const camDown = enabled && (
    isDown(capOf(telemetry, CAP_KEYS.camera))
    // 'stalled' 는 '없음'으로 치지 않는다 — 세그먼트 경계나 순단으로 흔히 뜨고, 그때마다
    // 영상 위에 문구를 덮으면 깜빡인다. 재접속에 실패한 'error' 만 없음으로 본다.
    || hlsHealth === 'error'
  )
  const thermalDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.thermal)) || !videoSeen.THERMAL)

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === document.documentElement
      setFullscreen(active)
      document.documentElement.classList.toggle('view-fullscreen', active)
    }
    // 마운트 시점에 한 번 맞춘다(S15P11E101-809).
    // 이 표시는 상단 KPI 와 좌측 패널을 display:none 으로 접는다. 그래서 표시가
    // 남아 있으면 '상단바와 KPI 가 사라진' 것으로 보이고, 새로고침해야 돌아온다.
    //
    // 예전에는 fullscreenchange 가 올 때만 맞췄고, 정리는 언마운트 cleanup 에 맡겼다.
    // 그런데 이 앱은 탭을 옮겨도 페이지를 언마운트하지 않는다 — 모든 페이지가 계속
    // 살아 있고 CSS 로만 감춘다. 그래서 cleanup 은 사실상 실행되지 않는다.
    // 어떤 이유로든(요청 거부, 다른 요소로의 전환, 브라우저 자체 전체화면) 이벤트가
    // 한 번 어긋나면 표시가 영영 남는다.
    //
    // 그래서 '이벤트가 오면 맞춘다' 가 아니라 '실제 상태와 늘 같게 둔다' 로 바꾼다.
    syncFullscreen()
    document.addEventListener('fullscreenchange', syncFullscreen)
    // 다른 창을 보다 돌아오는 순간에도 다시 맞춘다. 전체화면 해제가 이 문서 밖에서
    // 일어나면 fullscreenchange 가 오지 않을 수 있다.
    document.addEventListener('visibilitychange', syncFullscreen)
    window.addEventListener('focus', syncFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      document.removeEventListener('visibilitychange', syncFullscreen)
      window.removeEventListener('focus', syncFullscreen)
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
    <section id="pgCam" className="page on sim-skin nav-page v3-theme">
      <div className="cam-stage">
        {/* aside 에서 panel 을 뗀다(S15P11E101-797) — 껍데기가 카드이면 그 안의 두 패널이
            한 장에 붙어 보인다. 카드는 자식 둘이 각자 갖는다. */}
        <aside className="cam-side-panel" aria-label="순찰 로봇 수동 조작">
          <ControlPanel />
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
              {/* 🔴 라이브는 HLS <video>, 시뮬레이션은 종전 캔버스다.
                  시뮬은 Simulation.drawRcam() 이 가짜 카메라를 그 캔버스에 그리므로 남겨야
                  한다 — 라이브에서만 영상 경로가 HLS 로 바뀐 것이다. */}
              {enabled ? (
                <HlsVideo
                  className="camera-zoom-canvas"
                  style={{ transform: `scale(${swapped ? 1 : zoom})` }}
                  onHealth={setHlsHealth}
                />
              ) : (
                <canvas
                  ref={refs.rcam}
                  className="camera-zoom-canvas"
                  style={{ transform: `scale(${swapped ? 1 : zoom})` }}
                />
              )}
              {/* HUD(MODE …)·REC 표시는 제거했다 [사용자 지침 2026-08-09] — 실제 녹화 상태가
                  아닌 장식이라 영상을 가렸다. */}
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
              {/* 🔴 센서 90도 보정(S15P11E101-759)을 여기서 뺐다. 회전을 캔버스 요소에
                  걸면 센서 프레임뿐 아니라 그 안에 우리가 직접 그린 좌상단 라벨까지
                  같이 돌고, 프레임이 없는 시뮬 화면도 통째로 돌아간다.
                  이제 보정은 프레임을 그리는 자리에서 한다 — Simulation.ts 의
                  THERMAL_ROT_DEG. 전면 카메라와 똑같이 평범한 캔버스로 둔다. */}
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
