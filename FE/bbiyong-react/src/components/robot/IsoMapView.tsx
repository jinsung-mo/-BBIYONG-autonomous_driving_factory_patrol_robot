import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { isFloorplan } from '../../live/floorplan.ts'
import {
  buildExtrudeSource, releaseExtrudeSource, worldToPlanPx, WALL_H,
  type ExtrudeSource,
} from '../../live/isoExtrude.ts'
import { errMessage } from '../../live/errors.ts'
import { DISPLAY_ROT } from '../../live/navMap.ts'

// 2D 도면을 압출해 2.5D 로 보여주는 뷰 (S15P11E101-676).
//
// 데이터는 끝까지 2D 도면이다. 벽 픽셀만 켜진 마스크를 z 축으로 WALL_H 층 쌓고,
// 씬 전체를 rotateX/rotateZ 로 기울여 기둥처럼 보이게 한다. 진짜 3D 재구성이 아니다.
//
// 층은 <div> 로 쌓고 같은 마스크 이미지를 참조한다. 캔버스를 층마다 만들면 층 수만큼
// 픽셀 버퍼가 생기지만, 이렇게 하면 브라우저가 이미지를 한 번만 디코드한다.

const TILT_MIN = 20
const TILT_MAX = 82
const ZOOM_MIN = 0.4
const ZOOM_MAX = 3

/** 층 간격(px). 좁으면 이음새가 보이고 넓으면 계단처럼 보인다. */
const LAYER_STEP = 1.15
// nav 자세가 이 시간 안에 들어왔다면 텔레메트리로 덮지 않는다.
// 텔레메트리는 1Hz 라, 3Hz 인 nav 와 섞으면 마커가 앞뒤로 떨린다.
const NAV_FRESH_MS = 2500

// 표시 회전(S15P11E101-746). SLAM 뷰와 같은 값을 쓴다 — 두 화면이 다른 방향을 보면
// 조작자가 지도를 옮겨 볼 때마다 방향 감각을 다시 잡아야 한다.
// 씬 전체를 돌리므로 도면과 로봇 마커가 함께 돈다(마커는 씬 안에 있다).
const SPIN_BASE = -24 + (DISPLAY_ROT * 180) / Math.PI

export default function IsoMapView({ zoomFactor = 1 }: { zoomFactor?: number }) {
  const { plan, connected, onNavUpdate, robotOnline, telemetry } = useLive()
  const [src, setSrc] = useState<ExtrudeSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 보는 각도. 기울기(rotateX)와 방위(rotateZ), 확대.
  const [tilt, setTilt] = useState(58)
  const [spin, setSpin] = useState(SPIN_BASE)
  const [zoom, setZoom] = useState(1)
  const dragRef = useRef<{ x: number, y: number, tilt: number, spin: number } | null>(null)

  // 로봇 위치는 자주 바뀐다. 상태로 두면 프레임마다 다시 렌더되므로 DOM 을 직접 옮긴다.
  const markerRef = useRef<HTMLDivElement | null>(null)
  // 받은 값(목표)과 화면에 그리는 값(현재)을 나눠 둔다 — 사이를 보간한다
  const targetRef = useRef<{ x: number, y: number, yaw: number } | null>(null)
  const shownRef = useRef<{ x: number, y: number, yaw: number } | null>(null)
  // nav 자세를 마지막으로 받은 시각. 텔레메트리로 채울지 가르는 기준이다.
  const navAtRef = useRef(0)
  const planRef = useRef(plan)
  planRef.current = plan
  const srcRef = useRef(src)
  srcRef.current = src

  // 압출 재료 만들기. 도면이 바뀌면(FLOORPLAN_READY 로 새 도면이 오면) 다시 만든다.
  useEffect(() => {
    // RAW 점유격자는 압출하지 않는다. 미탐색 영역이 회색이라 '밝기<128' 판정이
    // 벽과 미탐색을 구분하지 못한다 — 도면 전체가 기둥이 되어 버린다.
    if (!plan?.img || !isFloorplan(plan)) { setSrc(null); setError(null); return undefined }
    let alive = true
    let made: ExtrudeSource | null = null
    setBusy(true); setError(null)
    buildExtrudeSource(plan.img)
      .then((s) => {
        made = s
        if (!alive) { releaseExtrudeSource(s); return }
        setSrc((prev) => { releaseExtrudeSource(prev); return s })
      })
      .catch((e) => { if (alive) setError(errMessage(e)) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false; if (!made) return }
  }, [plan])

  // 떠날 때 objectURL 을 푼다
  useEffect(() => () => releaseExtrudeSource(srcRef.current), [])

  // 로봇 위치 — 압출 씬의 픽셀 좌표로 옮긴다 (S15P11E101-745)
  //
  // 텔레메트리는 1~3Hz 라, 받은 값을 그대로 찍으면 마커가 초당 한두 번 순간이동한다.
  // 순찰을 '보고 있다' 는 느낌이 사라지고, 튀는 순간이 이상 동작처럼 읽힌다 —
  // 받은 값은 목표로 두고 매 프레임 그쪽으로 다가가게 한다.
  //
  // yaw 는 -π ~ π 를 오가므로 그냥 섞으면 한 바퀴를 거꾸로 돈다. 짧은 쪽으로 감는다.
  useEffect(() => {
    // 마커는 압출 소스가 준비된 뒤에야 그려진다. 마운트 시점에 ref 를 잡아 두면
    // 그때는 아직 null 이라 루프가 시작조차 못 한다 — 매 프레임 다시 찾는다.
    let raf = 0
    const step = () => {
      const el = markerRef.current
      const t = targetRef.current
      const c = shownRef.current
      if (el && t) {
        if (!c) {
          shownRef.current = { ...t }
        } else {
          const k = 0.18
          c.x += (t.x - c.x) * k
          c.y += (t.y - c.y) * k
          // 각도 차이를 -π ~ π 로 접은 뒤 섞는다
          let d = t.yaw - c.yaw
          while (d > Math.PI) d -= Math.PI * 2
          while (d < -Math.PI) d += Math.PI * 2
          c.yaw += d * k
        }
        const v = shownRef.current
        if (v) {
          el.style.display = ''
          el.style.left = `${v.x}px`
          el.style.top = `${v.y}px`
          el.style.setProperty('--yaw', `${-v.yaw}rad`)
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  // 목표 자세를 옮긴다. 자리를 계산하는 식은 한 곳에 둔다.
  const aim = (x: number, y: number, yaw: number) => {
    const el = markerRef.current
    const p = planRef.current
    const s2 = srcRef.current
    if (!el || !p || !s2) return
    const px = worldToPlanPx(p as any, x, y, s2.scale)
    targetRef.current = { x: px.x, y: px.y, yaw: Number.isFinite(yaw) ? yaw : 0 }
    // 로봇은 벽 위로 띄운다 — 바닥에 붙이면 기울인 화면에서 벽에 가린다
    el.style.setProperty('--rz', `${WALL_H * LAYER_STEP + 10}px`)
  }

  // 1순위: /topic/nav 의 자세. 3Hz 로 오고 스캔과 같은 시점이라 가장 정확하다.
  useEffect(() => onNavUpdate((nav: any) => {
    const el = markerRef.current
    if (!el) return
    const pose = nav?.pose
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return
    navAtRef.current = Date.now()
    aim(pose.x, pose.y, Number(pose.yaw))
  }), [onNavUpdate])

  // 2순위: /topic/robots 텔레메트리의 location(S15P11E101-745 계약).
  // nav 노드가 죽어도 로봇은 위치를 계속 보낸다 — 그때 마커가 사라지면
  // '로봇이 어디 있는지 모른다' 가 아니라 '로봇이 없다' 로 잘못 읽힌다.
  // nav 가 살아 있으면 건드리지 않는다. 두 소스가 번갈아 들어오면 마커가 떨린다.
  useEffect(() => {
    const loc = telemetry?.location
    if (!loc || !Number.isFinite(Number(loc.x)) || !Number.isFinite(Number(loc.y))) return
    if (Date.now() - navAtRef.current < NAV_FRESH_MS) return
    aim(Number(loc.x), Number(loc.y), Number(loc.yaw))
  }, [telemetry])

  // 두 소스 모두 자세를 주지 못하면 마커를 감춘다 — 없는 위치를 그리지 않는다.
  useEffect(() => {
    const el = markerRef.current
    if (!el) return
    if (!targetRef.current) { el.style.display = 'none'; shownRef.current = null }
  }, [plan])

  // 로봇이 꺼져 있으면 마커를 흐린다. 지우지는 않는다 —
  // 마지막으로 알던 자리는 남겨야 어디서 멈췄는지 알 수 있다.
  useEffect(() => {
    const el = markerRef.current
    if (el) el.classList.toggle('off', robotOnline === false)
  }, [robotOnline])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, tilt, spin }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setSpin(d.spin + (e.clientX - d.x) * 0.4)
    setTilt(Math.min(TILT_MAX, Math.max(TILT_MIN, d.tilt + (e.clientY - d.y) * 0.3)))
  }
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* 이미 놓임 */ }
  }
  const onWheel = (e: React.WheelEvent) => {
    // 지도 위에서 굴린 휠은 지도를 확대한다. 페이지가 함께 스크롤되면 조작이 어긋난다.
    e.preventDefault()
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * (e.deltaY > 0 ? 0.9 : 1.1))))
  }
  // 마우스에만 길을 두지 않는다 — 방향키로 돌리고 +/- 로 확대한다
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5
    if (e.key === 'ArrowLeft') { setSpin((v) => v - step); e.preventDefault() }
    else if (e.key === 'ArrowRight') { setSpin((v) => v + step); e.preventDefault() }
    else if (e.key === 'ArrowUp') { setTilt((v) => Math.max(TILT_MIN, v - step)); e.preventDefault() }
    else if (e.key === 'ArrowDown') { setTilt((v) => Math.min(TILT_MAX, v + step)); e.preventDefault() }
    else if (e.key === '+' || e.key === '=') { setZoom((z) => Math.min(ZOOM_MAX, z * 1.15)); e.preventDefault() }
    else if (e.key === '-') { setZoom((z) => Math.max(ZOOM_MIN, z / 1.15)); e.preventDefault() }
  }
  const reset = useCallback(() => { setTilt(58); setSpin(SPIN_BASE); setZoom(1) }, [])

  // 층. 위로 갈수록 밝게 — 빛이 위에서 온다.
  const layers = useMemo(() => Array.from({ length: WALL_H }, (_, k) => {
    const t = k / (WALL_H - 1)
    return {
      z: k * LAYER_STEP,
      // 바닥은 어둡고 꼭대기는 밝다. 꼭대기 한 층만 확실히 밝혀 윗면처럼 읽히게 한다.
      color: k === WALL_H - 1
        ? 'hsl(215 26% 74%)'
        : `hsl(215 22% ${18 + t * 34}%)`,
    }
  }), [])

  if (!plan) {
    return <span className="nodata">{connected ? '활성 도면이 없습니다' : '연결 대기'}</span>
  }
  if (!isFloorplan(plan)) {
    return <span className="nodata">정제 도면이 아니라 입체로 보여줄 수 없습니다 — 2D 로 보세요</span>
  }
  if (error) return <span className="nodata">{error}</span>
  if (busy && !src) return <span className="nodata">도면을 세우는 중…</span>
  if (!src) return <span className="nodata">도면을 세우지 못했습니다</span>
  if (src.wallRatio <= 0) return <span className="nodata">도면에서 벽을 찾지 못했습니다</span>

  return (
    <div
      className="iso-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="img"
      aria-label="순찰 구역 입체 지도 — 드래그하거나 방향키로 돌리고 휠 또는 +/− 로 확대"
    >
      <div
        className="iso-scene"
        style={{
          transform: `rotateX(${tilt}deg) rotateZ(${spin}deg) scale(${zoom * zoomFactor})`,
          width: src.w,
          height: src.h,
          marginLeft: -src.w / 2,
          marginTop: -src.h / 2,
        }}
      >
        {/* 바닥 — 도면 그림 그대로 */}
        <div className="iso-floor" style={{ backgroundImage: `url(${src.floorUrl})` }} />
        {/* 벽 — 같은 마스크를 층층이 쌓는다 */}
        {layers.map((l) => (
          <div
            key={l.z}
            className="iso-wall"
            style={{
              transform: `translateZ(${l.z}px)`,
              background: l.color,
              WebkitMaskImage: `url(${src.maskUrl})`,
              maskImage: `url(${src.maskUrl})`,
            }}
          />
        ))}
        {/* 로봇 — 벽 위로 띄우고, 화면을 돌려도 정면을 보게 한다 */}
        {/* 바닥에 눕는 몸체 + 진행 방향 코 + 위에서 늘 보이는 표시등.
            몸체는 씬과 같은 평면에 있어 도면 위에 '놓인' 것으로 읽히고,
            표시등은 화면을 돌려도 정면을 보게 둔다(빌보드). */}
        <div ref={markerRef} className="iso-robot" style={{ display: 'none' }}>
          <i className="iso-robot-body" />
          <i className="iso-robot-nose" />
          <i className="iso-robot-dot" />
        </div>
      </div>

      <button type="button" className="mapview iso-reset" onClick={reset} title="보는 각도 초기화">
        정면으로
      </button>
    </div>
  )
}
