import { useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { makeView, fitView, fitCanvas, drawNav, canvasToWorld, insideMap, backgroundOf, followPose } from '../../live/navMap.ts'
import { localized } from '../../live/mappers.ts'

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
// planOnly 를 주면 정제 도면만 그린다(S15P11E101-744). 실시간 SLAM 점유격자는
// 운영 탭 전용이 되었으므로, 지도 탭에서는 원본 격자로 되돌릴 길을 열어 두지 않는다.
// mapping 을 주면 라이브 매핑 화면이 된다(S15P11E101-763).
// 저장 도면 대신 원본 점유격자를 배경으로 쓰고, 지도가 넓어질 때마다 화면을 다시 맞춘다.
// follow 를 주면 로봇이 화면 가운데 오도록 따라간다(S15P11E101-775).
// 조작자가 드래그로 개입하면 따라가기를 멈추고, 버튼으로 되돌린다 —
// 보고 싶은 곳을 보고 있는데 화면이 제멋대로 끌려가면 그것이 더 답답하다.
// inspection 을 주면 AprilTag 점검 지점을 겹쳐 그린다(S15P11E101-787).
// onSetHeading 을 주면 지점을 눌러 바깥으로 드래그해 방향(heading)을 직접 정할 수 있다(S15P11E101-797).
// '자동'(yaw 없음)이던 지점도 전부 오른쪽(동쪽)으로 그려지는 버그가 있었는데(같은 티켓에서
// 별도로 고쳤다), 그것과 별개로 방향을 처음부터 직접 정할 방법이 없었다 — 목록의 숫자 입력은
// 도(degree)를 외워 타이핑해야 해서 지도 위에서 바로 가리키는 편이 훨씬 직관적이다.
// lightFloor 를 주면 캔버스 바탕을 흰색으로 칠한다(S15P11E101-822). 지도 탭·순찰 경로는
// '흰 바닥' 위에 도면을 얹는 편이 3D 입체 뷰(흰 바닥)와 통일돼 보기 편하다.
// compass 를 false 로 주면 우상단 나침반을 그리지 않는다(S15P11E101-814). 기본은 true —
// 관제 지도 탭(MapPanel)은 그대로 나침반을 보여준다.
export default function LiveNavMap({ route = null, onPick = null, onSetHeading = null, zoomFactor = 1, planOnly = false, mapping = false, follow = false, inspection = null, lightFloor = false, compass = true }: {
    route?: import('../../live/contracts').Waypoint[] | null,
    onPick?: ((p: { x: number, y: number } | null) => void) | null,
    onSetHeading?: ((index: number, yawRadians: number) => void) | null,
    zoomFactor?: number,
    planOnly?: boolean,
    mapping?: boolean,
    follow?: boolean,
    inspection?: { candidates?: any[], points?: any[], selectedId?: string | null } | null,
    lightFloor?: boolean,
    compass?: boolean,
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
  // 점검 지점도 자주 바뀐다 — 구독을 다시 걸지 않기 위해 ref 로 읽는다(S15P11E101-787)
  const inspectRef = useRef(inspection)
  inspectRef.current = inspection
  // 바탕색도 ref 로 읽는다 — 구독 effect 가 이 값을 세팅 시점에 가둬 stale 되지 않게 한다.
  const bgColorRef = useRef('#15171c')
  bgColorRef.current = lightFloor ? '#ffffff' : '#15171c'
  // 나침반 표시 여부도 ref 로 읽는다 — 구독 effect 를 다시 걸지 않기 위해서다.
  const compassRef = useRef(true)
  compassRef.current = compass
  // 정제 도면이 있으면 기본으로 보여준다(S15P11E101-524). 원본 점유격자로 되돌릴 수도 있어야 한다 —
  // 도면이 실제와 어긋나 보일 때 원본으로 확인할 방법이 없으면 곤란하다.
  // 따라가는 중인가. follow 를 켠 채로 들어오면 켜진 상태로 시작한다.
  const [following, setFollowing] = useState(follow)
  const followingRef = useRef(follow)
  followingRef.current = following && follow
  useEffect(() => { setFollowing(follow) }, [follow])
  // 드래그로 화면을 미는 중
  const panRef = useRef<{ x: number, y: number } | null>(null)

  const [showPlan, setShowPlan] = useState(true)
  const showPlanRef = useRef(true)
  // 매핑 중에는 토글과 무관하게 원본 격자를 쓴다. 저장 도면을 깔아 두면 지금 그리는
  // 지도가 그 아래 가려, 진행이 멈춘 것인지 도면이 덮은 것인지 구분되지 않는다.
  showPlanRef.current = mapping ? false : (planOnly ? true : showPlan)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const setHeadingRef = useRef(onSetHeading)
  setHeadingRef.current = onSetHeading

  // 방향 드래그 중 상태(S15P11E101-797). index/x/y 는 드래그를 시작한 지점(고정된 회전축).
  const headingDragRef = useRef<{ index: number, x: number, y: number } | null>(null)
  // 드래그 중 실시간으로 보여줄 방향 — 실제 route 는 손을 떼야(onPointerUp) 갱신한다.
  const headingPreviewRef = useRef<{ index: number, yaw: number } | null>(null)
  // 드래그를 마친 포인터업 뒤에는 같은 자리에서 click 이 한 번 더 온다 — 그 한 번만 무시한다.
  const suppressClickRef = useRef(false)

  // 드래그 중이면 미리보기 방향을 반영한 경로를 그린다 — 실제 route(prop)는 아직 그대로다.
  const routeForDraw = () => {
    const rte = routeRef.current
    const preview = headingPreviewRef.current
    if (!rte || !preview) return rte
    return rte.map((w, i) => (i === preview.index ? { ...w, yaw: preview.yaw } : w))
  }

  const redraw = () => {
    const cv = cvRef.current
    if (!cv || !lastRef.current) return
    const fitted = fitCanvas(cv)
    if (fitted) drawNav(fitted.g, cv, lastRef.current, viewRef.current, headingUpRef.current, routeForDraw(), showPlanRef.current, !planOnly, inspectRef.current, bgColorRef.current, compassRef.current)
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
      // 지도가 넓어져 다시 맞춘 뒤에도 로봇을 가운데로 되돌린다(S15P11E101-775).
      // refit 만 하면 새로 발견한 구역 쪽으로 화면이 끌려가 로봇이 가장자리로 밀린다.
      // 자세는 3Hz 로 온다. 한 프레임에 조금씩 따라가면 로봇이 화면 가장자리를 맴돈다 —
      // 눈에 띄게 흔들리지 않으면서 따라잡는 값이 이 정도다.
      // map 프레임이 아닌 자세는 믿을 수 없다(S15P11E101-773). 그 값으로 화면을 끌면
      // 지도가 엉뚱한 곳으로 밀려나고, 조작자는 그 사실조차 모른다 — 차라리 가만히 둔다.
      if (followingRef.current && localized(nav?.pose)) followPose(viewRef.current, cv, nav!.pose!, 0.5)
      drawNav(fitted.g, cv, nav, viewRef.current, headingUpRef.current, routeForDraw(), showPlanRef.current, !planOnly, inspectRef.current, bgColorRef.current, compassRef.current)
    }

    const off = onNavUpdate(render)
    // 패널 크기가 바뀌면 다시 맞춰 그린다 (그리드 레이아웃이라 창 크기에 따라 변한다)
    const ro = new ResizeObserver(() => render(lastRef.current))
    if (cv.parentElement) ro.observe(cv.parentElement)

    return () => { off(); ro.disconnect() }
  }, [onNavUpdate])

  // 토글·경로 변경 즉시 다시 그린다 (다음 NAV_LIVE 를 기다리면 최대 0.3초 늦다)
  useEffect(redraw, [headingUp, route, inspection, compass])

  // 매핑을 시작하면 화면을 처음부터 다시 맞춘다 — 이전 세션의 배율·중심이 남아 있으면
  // 새 지도가 화면 밖에서 그려지기 시작한다.
  useEffect(() => {
    viewRef.current = makeView()
    redraw()
  }, [mapping])

  // 지도 경계가 바뀌면 다시 맞춘다(S15P11E101-763).
  // SLAM 은 돌면서 지도를 넓힌다. 처음 맞춘 배율 그대로 두면 새로 발견한 구역이
  // 캔버스 밖으로 잘려 나가고, 조작자는 매핑이 멈춘 줄 안다.
  const boundsRef = useRef('')
  useEffect(() => {
    if (!mapping) return undefined
    let raf = 0
    const tick = () => {
      const cv = cvRef.current
      const nav = lastRef.current
      const bg = nav && backgroundOf(nav, showPlanRef.current)
      if (cv && bg) {
        const key = [bg.w, bg.h, bg.ox, bg.oy, bg.res].join('/')
        if (key !== boundsRef.current) {
          boundsRef.current = key
          fitView(viewRef.current, cv, bg)
          redraw()
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mapping])

  // 도면 ↔ 원본 전환, 새 도면 도착 — 크기·원점이 다를 수 있어 화면을 다시 맞춘다
  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !lastRef.current) return
    const bg = backgroundOf(lastRef.current, showPlanRef.current)
    if (bg) fitView(viewRef.current, cv, bg)
    redraw()
  }, [showPlan, planOnly, plan])

  // 지도 클릭 → map 프레임 미터. 맵 밖은 로봇이 갈 수 없는 좌표라 받지 않는다.
  const onClick = (e: any) => {
    // 방향 드래그를 막 마친 자리에서 브라우저가 이어서 보내는 click 하나는 무시한다 —
    // 안 그러면 방향을 정한 자리에 순찰 지점이 하나 더 찍힌다(S15P11E101-797).
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    const pick = pickRef.current
    const nav = lastRef.current
    const cv = cvRef.current
    // 배경이 도면이든 점유격자든, 화면에 그려진 것이 있으면 찍을 수 있다(S15P11E101-629).
    // 예전에는 nav.map(SLAM)만 봐서 도면만 있는 상태에서는 클릭이 통째로 막혔다.
    const bg = backgroundOf(nav, showPlanRef.current)
    if (!pick || !bg || !cv) return
    const r = cv.getBoundingClientRect()
    // 캔버스 내부 해상도와 표시 크기가 다를 수 있다(ResizeObserver 사이 시점) — 비율로 환산한다
    const px = (e.clientX - r.left) * (cv.width / r.width)
    const py = (e.clientY - r.top) * (cv.height / r.height)
    const { x, y } = canvasToWorld(viewRef.current, nav, headingUpRef.current, px, py, cv)
    if (!insideMap(bg, x, y)) { pick(null); return }
    pick({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) })
  }

  // 캔버스 픽셀(내부 해상도 기준)로 환산한 클라이언트 좌표 → map 프레임 미터.
  const clientToWorld = (cv: HTMLCanvasElement, clientX: number, clientY: number) => {
    const r = cv.getBoundingClientRect()
    const px = (clientX - r.left) * (cv.width / r.width)
    const py = (clientY - r.top) * (cv.height / r.height)
    return canvasToWorld(viewRef.current, lastRef.current, headingUpRef.current, px, py, cv)
  }

  // 이 클라이언트 좌표에서 가장 가까운 순찰 지점(히트 반경 안)의 인덱스. 없으면 -1.
  // canvasToWorld 로 화면→월드를 이미 되돌린 뒤라 회전(북향 고정/heading-up) 과 무관하게 맞는다.
  const nearestRouteIndex = (cv: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rte = routeRef.current
    if (!rte || !rte.length) return -1
    const { x, y } = clientToWorld(cv, clientX, clientY)
    // 화면에 그려진 지점 반지름(9px, drawNav 와 맞춤)에 손가락 여유를 더해 미터로 환산.
    const hitMeters = 16 / Math.max(1, viewRef.current.s)
    let best = -1, bestDist = hitMeters
    rte.forEach((w, i) => {
      const d = Math.hypot(Number(w.x) - x, Number(w.y) - y)
      if (d <= bestDist) { bestDist = d; best = i }
    })
    return best
  }

  return (
    <>
      <canvas
        ref={cvRef}
        onClick={onPick ? onClick : undefined}
        onPointerDown={(e) => {
          // 방향을 설정할 수 있는 화면에서, 순찰 지점 위(히트 반경 안)를 눌렀으면
          // 패닝이 아니라 방향 드래그를 시작한다(S15P11E101-797).
          const cv = cvRef.current
          if (setHeadingRef.current && cv) {
            const idx = nearestRouteIndex(cv, e.clientX, e.clientY)
            if (idx >= 0) {
              const w = routeRef.current![idx]
              headingDragRef.current = { index: idx, x: Number(w.x), y: Number(w.y) }
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              return
            }
          }
          // 조작자가 화면을 밀기 시작하면 따라가기를 멈춘다 — 보려는 곳을 보게 둔다
          panRef.current = { x: e.clientX, y: e.clientY }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          if (followingRef.current) setFollowing(false)
        }}
        onPointerMove={(e) => {
          const hd = headingDragRef.current
          const cv = cvRef.current
          if (hd && cv) {
            const { x, y } = clientToWorld(cv, e.clientX, e.clientY)
            const dx = x - hd.x, dy = y - hd.y
            // 뗀 자리 바로 근처에서는 각도가 튄다 — 최소 거리를 넘어야 방향으로 인정한다.
            if (Math.hypot(dx, dy) < 0.08) return
            headingPreviewRef.current = { index: hd.index, yaw: Math.atan2(dy, dx) }
            redraw()
            return
          }
          const p = panRef.current
          if (!p) return
          if (!cv) return
          const r = cv.getBoundingClientRect()
          // 표시 크기와 내부 해상도가 다를 수 있다 — 비율로 환산해 민다
          viewRef.current.x += (e.clientX - p.x) * (cv.width / r.width)
          viewRef.current.y += (e.clientY - p.y) * (cv.height / r.height)
          panRef.current = { x: e.clientX, y: e.clientY }
          redraw()
        }}
        onPointerUp={(e) => {
          const hd = headingDragRef.current
          if (hd) {
            const preview = headingPreviewRef.current
            headingDragRef.current = null
            headingPreviewRef.current = null
            try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* 이미 놓임 */ }
            // 실제로 방향을 그려 본 드래그만 반영한다 — 누르고 그대로 뗐다면(미리보기 없음)
            // 아무것도 바꾸지 않는다(클릭으로 오인해 되돌리는 게 아니라 처음부터 값이 없었던 것).
            if (preview) {
              setHeadingRef.current?.(preview.index, preview.yaw)
              suppressClickRef.current = true
            }
            redraw()
            return
          }
          panRef.current = null
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={() => {
          panRef.current = null
          headingDragRef.current = null
          headingPreviewRef.current = null
        }}
        className="map-zoom-canvas"
        style={{
          cursor: onPick ? 'crosshair' : undefined,
          transform: `scale(${zoomFactor})`,
        }}
      />
      {/* 북향 고정/진행방향 위 토글 제거(S15P11E101 콘솔 정리) — 도면은 항상 정치(북향/수평)로 둔다.
          headingUp 은 false 로 고정되어 도면이 회전 없이 수평으로 표시된다. */}
      {plan && !planOnly && !mapping && (
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
      {follow && !following && (
        <button
          type="button" className="mapview follow-back" id="btnFollowRobot"
          onClick={() => setFollowing(true)}
          title="로봇을 다시 화면 가운데로"
        >
          로봇 따라가기
        </button>
      )}
      {!connected && <span className="hud">연결 대기</span>}
    </>
  )
}
