import { useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.jsx'
import { makeView, fitView, fitCanvas, drawNav } from '../../live/navMap.js'

// live 모드의 2D 맵 캔버스 — 로봇이 보내는 실제 SLAM 맵/스캔/자세를 그린다.
// 렌더 로직은 navMap.js(로봇팀 nav.html 포팅)에 있고, 여기서는 캔버스 수명주기만 다룬다.
export default function LiveNavMap() {
  const { onNavUpdate, connected } = useLive()
  const cvRef = useRef(null)
  const viewRef = useRef(makeView())
  const lastRef = useRef(null)
  // 북향 고정(기본) ↔ heading-up. 주행 중에는 진행 방향이 위를 향하는 편이 방향 감각을 유지하기 쉽다.
  const [headingUp, setHeadingUp] = useState(false)
  const headingUpRef = useRef(false)
  headingUpRef.current = headingUp

  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return undefined

    const render = (nav) => {
      lastRef.current = nav
      const fitted = fitCanvas(cv)
      if (!fitted) return // 패널이 아직 0 크기 — 다음 갱신에 다시 시도한다
      // 첫 맵이거나 캔버스 크기가 바뀌었으면 맵을 화면에 다시 맞춘다
      if (nav?.map && (!viewRef.current.init || fitted.resized)) fitView(viewRef.current, cv, nav.map)
      drawNav(fitted.g, cv, nav, viewRef.current, headingUpRef.current)
    }

    const off = onNavUpdate(render)
    // 패널 크기가 바뀌면 다시 맞춰 그린다 (그리드 레이아웃이라 창 크기에 따라 변한다)
    const ro = new ResizeObserver(() => render(lastRef.current))
    ro.observe(cv.parentElement)

    return () => { off(); ro.disconnect() }
  }, [onNavUpdate])

  // 토글 즉시 다시 그린다 (다음 NAV_LIVE 를 기다리면 최대 0.3초 늦다)
  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !lastRef.current) return
    const fitted = fitCanvas(cv)
    if (fitted) drawNav(fitted.g, cv, lastRef.current, viewRef.current, headingUp)
  }, [headingUp])

  return (
    <>
      <canvas ref={cvRef} />
      <button
        type="button"
        className="mapview"
        onClick={() => setHeadingUp((v) => !v)}
        aria-pressed={headingUp}
        title="지도 방향 전환"
      >
        {headingUp ? '진행 방향 위' : '북향 고정'}
      </button>
      {!connected && <span className="hud">연결 대기</span>}
    </>
  )
}
