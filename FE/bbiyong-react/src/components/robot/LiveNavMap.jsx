import { useEffect, useRef } from 'react'
import { useLive } from '../../live/LiveContext.jsx'
import { makeView, fitView, fitCanvas, drawNav } from '../../live/navMap.js'

// live 모드의 2D 맵 캔버스 — 로봇이 보내는 실제 SLAM 맵/스캔/자세를 그린다.
// 렌더 로직은 navMap.js(로봇팀 nav.html 포팅)에 있고, 여기서는 캔버스 수명주기만 다룬다.
export default function LiveNavMap() {
  const { onNavUpdate, connected } = useLive()
  const cvRef = useRef(null)
  const viewRef = useRef(makeView())
  const lastRef = useRef(null)

  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return undefined

    const render = (nav) => {
      lastRef.current = nav
      const fitted = fitCanvas(cv)
      if (!fitted) return // 패널이 아직 0 크기 — 다음 갱신에 다시 시도한다
      // 첫 맵이거나 캔버스 크기가 바뀌었으면 맵을 화면에 다시 맞춘다
      if (nav?.map && (!viewRef.current.init || fitted.resized)) fitView(viewRef.current, cv, nav.map)
      drawNav(fitted.g, cv, nav, viewRef.current)
    }

    const off = onNavUpdate(render)
    // 패널 크기가 바뀌면 다시 맞춰 그린다 (그리드 레이아웃이라 창 크기에 따라 변한다)
    const ro = new ResizeObserver(() => render(lastRef.current))
    ro.observe(cv.parentElement)

    return () => { off(); ro.disconnect() }
  }, [onNavUpdate])

  return (
    <>
      <canvas ref={cvRef} />
      {!connected && <span className="hud">연결 대기</span>}
    </>
  )
}
