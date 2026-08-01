import { useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { makeView, fitView, fitCanvas, drawNav, canvasToWorld, insideMap, backgroundOf } from '../../live/navMap.ts'

// live 모드의 2D 맵 캔버스 — 로봇이 보내는 실제 SLAM 맵/스캔/자세를 그린다.
// 렌더 로직은 navMap.js(로봇팀 nav.html 포팅)에 있고, 여기서는 캔버스 수명주기만 다룬다.
//
// route/onPick 을 주면 순찰 경로를 겹쳐 그리고 클릭으로 지점을 찍을 수 있다(S15P11E101-514).
// 관제 화면은 이 두 값을 주지 않으므로 기존과 똑같이 동작한다.
/**
 * @param {{
 *   route?: import('../../live/contracts').Waypoint[] | null,
 *   onPick?: ((p: { x: number, y: number } | null) => void) | null,
 * }} props
 */
export default function LiveNavMap({ route = null, onPick = null }: {
    route?: import('../../live/contracts').Waypoint[] | null,
    onPick?: ((p: { x: number, y: number } | null) => void) | null,
  }) {
  const { onNavUpdate, connected, plan } = useLive()
  const cvRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef(makeView())
  const lastRef = useRef<import('../../live/contracts.d.ts').NavState | null>(null)
  // 북향 고정(기본) ↔ heading-up. 주행 중에는 진행 방향이 위를 향하는 편이 방향 감각을 유지하기 쉽다.
  const [headingUp, setHeadingUp] = useState(false)
  const headingUpRef = useRef(false)
  headingUpRef.current = headingUp
  // 경로는 자주 바뀌므로 ref 로 읽는다 — 구독을 다시 걸지 않기 위해서다.
  const routeRef = useRef(route)
  routeRef.current = route
  // 정제 도면이 있으면 기본으로 보여준다(S15P11E101-524). 원본 점유격자로 되돌릴 수도 있어야 한다 —
  // 도면이 실제와 어긋나 보일 때 원본으로 확인할 방법이 없으면 곤란하다.
  const [showPlan, setShowPlan] = useState(true)
  const showPlanRef = useRef(true)
  showPlanRef.current = showPlan
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  const redraw = () => {
    const cv = cvRef.current
    if (!cv || !lastRef.current) return
    const fitted = fitCanvas(cv)
    if (fitted) drawNav(fitted.g, cv, lastRef.current, viewRef.current, headingUpRef.current, routeRef.current, showPlanRef.current)
  }

  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return undefined

    const render = (nav: any) => {
      lastRef.current = nav
      const fitted = fitCanvas(cv)
      if (!fitted) return // 패널이 아직 0 크기 — 다음 갱신에 다시 시도한다
      // 첫 맵이거나 캔버스 크기가 바뀌었으면 맵을 화면에 다시 맞춘다
      // 배경(도면 또는 원본) 기준으로 맞춘다 — 도면만 있고 원본이 없을 수도 있다
      const bg = backgroundOf(nav, showPlanRef.current)
      if (bg && (!viewRef.current.init || fitted.resized)) fitView(viewRef.current, cv, bg)
      drawNav(fitted.g, cv, nav, viewRef.current, headingUpRef.current, routeRef.current, showPlanRef.current)
    }

    const off = onNavUpdate(render)
    // 패널 크기가 바뀌면 다시 맞춰 그린다 (그리드 레이아웃이라 창 크기에 따라 변한다)
    const ro = new ResizeObserver(() => render(lastRef.current))
    if (cv.parentElement) ro.observe(cv.parentElement)

    return () => { off(); ro.disconnect() }
  }, [onNavUpdate])

  // 토글·경로 변경 즉시 다시 그린다 (다음 NAV_LIVE 를 기다리면 최대 0.3초 늦다)
  useEffect(redraw, [headingUp, route])

  // 도면 ↔ 원본 전환, 새 도면 도착 — 크기·원점이 다를 수 있어 화면을 다시 맞춘다
  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !lastRef.current) return
    const bg = backgroundOf(lastRef.current, showPlan)
    if (bg) fitView(viewRef.current, cv, bg)
    redraw()
  }, [showPlan, plan])

  // 지도 클릭 → map 프레임 미터. 맵 밖은 로봇이 갈 수 없는 좌표라 받지 않는다.
  const onClick = (e: any) => {
    const pick = pickRef.current
    const nav = lastRef.current
    const cv = cvRef.current
    if (!pick || !nav?.map || !cv) return
    const r = cv.getBoundingClientRect()
    // 캔버스 내부 해상도와 표시 크기가 다를 수 있다(ResizeObserver 사이 시점) — 비율로 환산한다
    const px = (e.clientX - r.left) * (cv.width / r.width)
    const py = (e.clientY - r.top) * (cv.height / r.height)
    const { x, y } = canvasToWorld(viewRef.current, nav, headingUpRef.current, px, py)
    if (!insideMap(nav.map, x, y)) { pick(null); return }
    pick({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) })
  }

  return (
    <>
      <canvas
        ref={cvRef}
        onClick={onPick ? onClick : undefined}
        style={onPick ? { cursor: 'crosshair' } : undefined}
      />
      <button
        type="button"
        className="mapview"
        onClick={() => setHeadingUp((v) => !v)}
        aria-pressed={headingUp}
        title="지도 방향 전환"
      >
        {headingUp ? '진행 방향 위' : '북향 고정'}
      </button>
      {plan && (
        <button
          type="button"
          className="mapview mapkind"
          onClick={() => setShowPlan((v) => !v)}
          aria-pressed={showPlan}
          title={showPlan ? '원본 점유격자로 보기' : '정제 도면으로 보기'}
        >
          {showPlan ? `도면${plan.kind === 'FLOORPLAN' ? '' : ' (원본)'}` : '원본 격자'}
        </button>
      )}
      {!connected && <span className="hud">연결 대기</span>}
    </>
  )
}
