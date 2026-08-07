import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { isFloorplan } from '../../live/floorplan.ts'
import {
  buildExtrudeSource, releaseExtrudeSource, worldToScenePx, WALL_H,
  type ExtrudeSource,
} from '../../live/isoExtrude.ts'
import { errMessage } from '../../live/errors.ts'
import { isMapFrame, localized } from '../../live/mappers.ts'
import { DISPLAY_ROT } from '../../live/navMap.ts'
import type { InspectionPoint } from '../../live/contracts.d.ts'

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
/** 방향키 한 번에 옮기는 거리(px). 한 번 눌러 움직인 것이 보여야 하고,
    그렇다고 화면 밖으로 튀어서도 안 되는 값이다(S15P11E101-777). */
const PAN_STEP = 48
/** 이보다 멀리는 못 간다 — 지도를 잃어버리고 빈 화면만 남는 일을 막는다. */
const PAN_MAX = 1200

/** 층 간격(px). 좁으면 이음새가 보이고 넓으면 계단처럼 보인다.
    1.15 → 0.77 (2026-08-07): 벽(≈46px)이 방을 압도해 내부가 안 보인다는 피드백으로
    총 높이를 2/3(≈31px)로 낮췄다. 층 수(WALL_H)를 줄이는 대신 간격을 좁혀,
    옆면 음영 계단이 오히려 부드러워진다. */
const LAYER_STEP = 0.77
// nav 자세가 이 시간 안에 들어왔다면 텔레메트리로 덮지 않는다.
// 텔레메트리는 1Hz 라, 3Hz 인 nav 와 섞으면 마커가 앞뒤로 떨린다.
const NAV_FRESH_MS = 2500

// 차체 높이(S15P11E101-750). 벽(WALL_H * LAYER_STEP ≈ 31px)보다 낮아야 방 안의
// 물건으로 읽힌다 — 벽보다 크면 로봇이 건물을 밟고 선 것처럼 보인다.
// 목표까지 이보다 멀면 아직 가는 중이다. 보간 잔차(1px 미만)와 갈리는 값이다.
const MOVING_PX = 1.2
// 멈춘 뒤에도 잠시 켜 둔다. 프레임마다 껐다 켜면 신호등처럼 깜빡인다.
const MOVING_HOLD_MS = 700
const CAR_H = 11
// 판을 쌓아 부피를 만든다. 벽과 같은 방식이라 같은 씬의 물건으로 읽힌다.
// 위로 갈수록 밝게 — 748 에서 벽에 쓴 것과 같은 폭(좁은 음영)을 지킨다.
const CAR_LAYERS = Array.from({ length: CAR_H }, (_, k) => ({
  z: k,
  color: `hsl(158 32% ${34 + (k / (CAR_H - 1)) * 16}%)`,
}))

// 표시 회전. SLAM 뷰(navMap.DISPLAY_ROT, 현재 0 — S15P11E101-796)와 같은 값을 쓴다 —
// 두 화면이 다른 방향을 보면 조작자가 지도를 옮겨 볼 때마다 방향 감각을 다시 잡아야 한다.
// 씬 전체를 돌리므로 도면과 로봇 마커가 함께 돈다(마커는 씬 안에 있다).
const SPIN_BASE = -24 + (DISPLAY_ROT * 180) / Math.PI

export default function IsoMapView({ zoomFactor = 1, points = [] }: { zoomFactor?: number, points?: InspectionPoint[] }) {
  const { plan, connected, onNavUpdate, robotOnline, telemetry } = useLive()
  // 텔레메트리가 map 이 아니라고 말하면 그린 것을 거둔다(S15P11E101-773)
  const unlocalized = !!telemetry?.location && !isMapFrame(telemetry.location)
  const [src, setSrc] = useState<ExtrudeSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 보는 각도. 기울기(rotateX)와 방위(rotateZ), 확대.
  const [tilt, setTilt] = useState(58)
  const [spin, setSpin] = useState(SPIN_BASE)
  const [zoom, setZoom] = useState(1)
  // 화면 이동(S15P11E101-777). 확대해 놓고 구석을 보려면 옮길 길이 있어야 한다.
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number, y: number, tilt: number, spin: number } | null>(null)

  // 로봇 추종(체이스캠) — S15P11E101-835. 켜면 로봇을 화면 중앙에 두고 진행 방향이
  // 위를 향하도록 씬을 돌린다(자동차 게임 시점). 씬 transform 을 매 프레임 직접 쓰므로
  // (setState 로 몰면 벽 층 divs 가 전부 다시 그려져 끊긴다) 관련 값은 ref 로도 읽는다.
  const [follow, setFollow] = useState(false)
  const followRef = useRef(false)
  followRef.current = follow
  const sceneRef = useRef<HTMLDivElement | null>(null)
  const tiltRef = useRef(tilt)
  tiltRef.current = tilt
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const zoomFactorRef = useRef(zoomFactor)
  zoomFactorRef.current = zoomFactor

  // 로봇 위치는 자주 바뀐다. 상태로 두면 프레임마다 다시 렌더되므로 DOM 을 직접 옮긴다.
  const markerRef = useRef<HTMLDivElement | null>(null)
  // 받은 값(목표)과 화면에 그리는 값(현재)을 나눠 둔다 — 사이를 보간한다
  const targetRef = useRef<{ x: number, y: number, yaw: number } | null>(null)
  const shownRef = useRef<{ x: number, y: number, yaw: number } | null>(null)
  // nav 자세를 마지막으로 받은 시각. 텔레메트리로 채울지 가르는 기준이다.
  const navAtRef = useRef(0)
  // 이동 중 표시. 목표에 이만큼 못 미치면 아직 가고 있는 것으로 본다.
  const movingUntilRef = useRef(0)
  const movingRef = useRef(false)
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
          // 차체 앞부분 방향(S15P11E101-835). 차체 로컬은 -y(위)가 앞이고, CSS 는
          // rotate(var(--yaw)) 로 시계방향(y-down)으로 돈다. 월드 yaw 를 씬 픽셀(y-down)
          // 방향 (cos yaw, -sin yaw) 으로 보내려면 회전각이 (π/2 - yaw) 여야 한다 —
          // 2D 지도 화살표와 같은 규약이다. 예전 -yaw 는 앞이 90° 어긋나 있었다.
          el.style.setProperty('--yaw', `${Math.PI / 2 - v.yaw}rad`)
          // 이동 중인가(S15P11E101-750). 목표와의 거리로 잰다 — 텔레메트리의 speed 는
          // 1Hz 라 짧은 이동을 놓치고, 여기 값은 매 프레임 갱신되므로 화면과 어긋나지 않는다.
          // 멈춘 순간 바로 끄면 신호등처럼 깜빡인다 — 잠시 유지하고 끈다.
          const far = Math.hypot(t.x - v.x, t.y - v.y) > MOVING_PX
          if (far) movingUntilRef.current = performance.now() + MOVING_HOLD_MS
          const moving = performance.now() < movingUntilRef.current
          if (moving !== movingRef.current) {
            movingRef.current = moving
            el.classList.toggle('moving', moving)
          }
        }
      }
      // 추종 시점 — 로봇을 화면 중앙에 두고(transform-origin=로봇) 진행 방향을 위로 돌린다.
      // 로봇이 없으면(shownRef 없음) 아무것도 몰지 않는다 — 없는 자리를 좇지 않는다.
      const sc = sceneRef.current
      const s2 = srcRef.current
      const v2 = shownRef.current
      if (sc && s2 && followRef.current && v2) {
        const z = zoomRef.current * zoomFactorRef.current
        // 씬 회전: 차체 front(시계각 -yaw)를 위(-90°)로 보낸다 → spin = deg(yaw) - 90
        const spinFollow = (v2.yaw * 180) / Math.PI - 90
        sc.style.transformOrigin = `${v2.x}px ${v2.y}px`
        sc.style.transform = `translate(${s2.w / 2 - v2.x}px, ${s2.h / 2 - v2.y}px) rotateX(${tiltRef.current}deg) rotateZ(${spinFollow}deg) scale(${z})`
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
    // 씬 픽셀 공간은 격자 셀이 아니라 도면 이미지 픽셀이다(S15P11E101-789).
    // 맵 전체 대비 비율로 옮겨야 2D 와 같은 자리에 찍힌다.
    const px = worldToScenePx(p as any, x, y, { w: s2.w, h: s2.h })
    targetRef.current = { x: px.x, y: px.y, yaw: Number.isFinite(yaw) ? yaw : 0 }
    // 로봇은 바닥에 붙인다(2026-08-07). 745 는 '벽에 가린다' 는 이유로 벽 위에 띄웠지만,
    // 그 결과가 '로봇이 공중에 둥둥 떠 있다' 는 더 큰 오독을 만들었다 — 순찰 로봇은
    // 바닥을 달리는 물건이다. 벽 뒤에 가릴 때를 위해 차체에서 벽보다 높이 솟는
    // 광선 기둥(.iso-robot::before)을 세워 자리를 잃지 않게 한다. 벽도 2/3 로 낮아져
    // (≈31px) 가림 자체가 줄었다. z=2 는 바닥 판·벽 0층과의 z-fighting 을 피하는 여유다.
    el.style.setProperty('--rz', '2px')
    el.style.setProperty('--car-h', `${CAR_H}px`)
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
    // 로컬라이즈되지 않은 좌표는 map 이 아니다 — 도면 위에 그리면 엉뚱한 자리에 찍힌다(773)
    if (!loc || !localized(loc)) return
    if (Date.now() - navAtRef.current < NAV_FRESH_MS) return
    aim(Number(loc.x), Number(loc.y), Number(loc.yaw))
  }, [telemetry])

  // 두 소스 모두 자세를 주지 못하면 마커를 감춘다 — 없는 위치를 그리지 않는다.
  useEffect(() => {
    const el = markerRef.current
    if (!el) return
    if (!targetRef.current) { el.style.display = 'none'; shownRef.current = null }
  }, [plan])

  // 위치를 믿을 수 없으면 마커를 아예 지운다(S15P11E101-773).
  // 흐리게 두지 않는다 — 흐린 마커도 '저기 있다' 로 읽힌다. 모르면 안 그린다.
  useEffect(() => {
    const el = markerRef.current
    if (!el) return
    if (unlocalized) {
      targetRef.current = null
      shownRef.current = null
      el.style.display = 'none'
    }
  }, [unlocalized])

  // 로봇이 꺼져 있으면 마커를 흐린다. 지우지는 않는다 —
  // 마지막으로 알던 자리는 남겨야 어디서 멈췄는지 알 수 있다.
  useEffect(() => {
    const el = markerRef.current
    if (el) el.classList.toggle('off', robotOnline === false)
  }, [robotOnline])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (followRef.current) return   // 추종 중에는 카메라를 자동으로 몬다 — 수동 조작을 막는다
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
    const next = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * (e.deltaY > 0 ? 0.9 : 1.1)))
    // 추종 중에도 확대/축소는 허용한다 — 씬 transform 은 추종 루프가 zoomRef 로 다시 쓴다.
    zoomRef.current = next(zoomRef.current)
    setZoom(next)
  }
  // 마우스에만 길을 두지 않는다.
  //   방향키       — 지도를 옮긴다(S15P11E101-777)
  //   Shift+방향키 — 돌린다·기울인다 (748 에서 방향키에 있던 것을 옮겼다.
  //                 돌리는 길은 드래그로도 있지만 키보드만 쓰는 사람에게는 여기뿐이다)
  //   +/-          — 확대
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (followRef.current) return   // 추종 중에는 이동·회전 키를 막는다 — 카메라는 자동이다
    const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      || e.key === 'ArrowUp' || e.key === 'ArrowDown'
    if (arrow && e.shiftKey) {
      const step = 15
      if (e.key === 'ArrowLeft') setSpin((v) => v - step)
      else if (e.key === 'ArrowRight') setSpin((v) => v + step)
      else if (e.key === 'ArrowUp') setTilt((v) => Math.max(TILT_MIN, v - step))
      else setTilt((v) => Math.min(TILT_MAX, v + step))
      e.preventDefault()
      return
    }
    if (arrow) {
      // 확대해 놓았으면 한 번에 더 많이 움직여야 같은 거리를 간다 —
      // 배율만큼 나누면 화면에서 느껴지는 이동량이 일정해진다.
      const step = PAN_STEP / Math.max(0.4, zoom * zoomFactor)
      const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
      setPan((p) => ({
        x: Math.min(PAN_MAX, Math.max(-PAN_MAX, p.x + dx)),
        y: Math.min(PAN_MAX, Math.max(-PAN_MAX, p.y + dy)),
      }))
      e.preventDefault()
      return
    }
    if (e.key === '+' || e.key === '=') { setZoom((z) => Math.min(ZOOM_MAX, z * 1.15)); e.preventDefault() }
    else if (e.key === '-') { setZoom((z) => Math.max(ZOOM_MIN, z / 1.15)); e.preventDefault() }
  }
  // 추종을 끄면 씬을 직접 몰던 transform-origin 을 비워, React 상태 기반 transform 이
  // 다시 정상으로 먹게 한다(안 비우면 회전축이 로봇에 남아 개요 시점이 틀어진다).
  useEffect(() => {
    const sc = sceneRef.current
    if (!follow && sc) sc.style.transformOrigin = ''
  }, [follow])
  const toggleFollow = useCallback(() => {
    setFollow((on) => {
      if (on) {
        // 끄는 길: 회전축을 즉시 비우고 기본 개요 시점으로 되돌린다.
        const sc = sceneRef.current
        if (sc) sc.style.transformOrigin = ''
        setTilt(58); setSpin(SPIN_BASE); setZoom(1); setPan({ x: 0, y: 0 })
        return false
      }
      return true
    })
  }, [])

  // 층. 위로 갈수록 밝게 — 빛이 위에서 온다(S15P11E101-748).
  //
  // 이전에는 하늘색(215 22%)에 아래 18% → 위 52% 로 명도차가 34 였다. 기둥 하나에
  // 그만큼 차이가 나면 벽이 아니라 발광체처럼 보이고, 채도까지 있어 도면 위에서 튄다.
  // 채도를 거의 빼고 폭을 절반 이하로 좁힌다 — 음영은 '있다' 만 알리면 된다.
  const layers = useMemo(() => Array.from({ length: WALL_H }, (_, k) => {
    const t = k / (WALL_H - 1)
    return {
      z: k * LAYER_STEP,
      // 꼭대기 한 층만 조금 더 밝혀 윗면으로 읽히게 한다. 그 차이도 크지 않다.
      color: k === WALL_H - 1
        ? 'hsl(214 10% 76%)'
        : `hsl(214 8% ${56 + t * 14}%)`,
    }
  }), [])

  // 장애물 층. 벽의 절반 높이, 청회색 — 낮고 색이 달라 '치울 수 있는 것' 으로 읽힌다.
  // 명도 폭은 벽과 같게 좁힌다(748). 한 물건 안에서 명도가 크게 벌어지면 발광체처럼 보인다.
  // 주황 → 청회색(2026-08-07): 주황은 분전반 표식(호박색)과 같은 계열로 읽혀,
  // 벽 옆 장애물이 분전반으로 오인됐다. 2D 지도 범례의 장애물색(#59637a)과 계열을 맞춘다.
  const obstacleLayers = useMemo(() => {
    const n = Math.max(2, Math.round(WALL_H * 0.45))
    return Array.from({ length: n }, (_, k) => ({
      z: k * LAYER_STEP,
      t: k / (n - 1),
    })).map((l) => ({
      z: l.z,
      color: `hsl(222 14% ${44 + l.t * 14}%)`,
    }))
  }, [])

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
      aria-label="순찰 구역 입체 지도 — 방향키로 이동, Shift+방향키로 회전, 휠 또는 +/− 로 확대, 드래그로 회전"
    >
      <div
        ref={sceneRef}
        className="iso-scene"
        style={{
          // translate 를 회전보다 앞에 둔다 — 기울어진 지도 안이 아니라 화면 기준으로
          // 움직여야, 누른 방향과 지도가 가는 방향이 같다.
          transform: `translate(${pan.x}px, ${pan.y}px) rotateX(${tilt}deg) rotateZ(${spin}deg) scale(${zoom * zoomFactor})`,
          width: src.w,
          height: src.h,
          marginLeft: -src.w / 2,
          marginTop: -src.h / 2,
        }}
      >
        {/* 바닥 — 흰 판 한 장(S15P11E101-777). 도면 그림을 깔면 벽 그림자·미탐색
            얼룩이 기둥과 뒤섞여, 어디가 실제 벽인지 눈이 한 번 더 헤맨다. */}
        <div className="iso-floor" />
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
        {/* 장애물 — 벽보다 낮고 청회색(S15P11E101-777). 벽은 건물이라 못 치우지만
            장애물은 사람이 치울 수 있는 것이다. 같은 색이면 그 구분이 사라진다. */}
        {src.obstacleUrl && obstacleLayers.map((l) => (
          <div
            key={`o${l.z}`}
            className="iso-wall iso-obst"
            style={{
              transform: `translateZ(${l.z}px)`,
              background: l.color,
              WebkitMaskImage: `url(${src.obstacleUrl})`,
              maskImage: `url(${src.obstacleUrl})`,
            }}
          />
        ))}
        {/* 로봇 — 바닥에 붙인다(2026-08-07, 공중 부양 오독 수정). */}
        {/* 차량형 마커(S15P11E101-750). 벽과 같은 방식으로 판을 쌓아 부피를 만든다 —
            벽만 입체이고 로봇만 납작하면 같은 씬의 물건으로 읽히지 않는다.
            차체는 yaw 로 돌고, 앞머리의 등이 진행 방향을 알린다.
            바닥에는 접지 그림자를, 위로는 벽보다 높이 솟는 광선 기둥을 세워
            벽 뒤에 가려도 자리를 잃지 않게 한다. */}
        <div ref={markerRef} className="iso-robot" style={{ display: 'none' }}>
          <i className="iso-car-shadow" />
          <div className="iso-car">
            {CAR_LAYERS.map((c) => (
              <i key={c.z} className="iso-car-plate" style={{ transform: `translateZ(${c.z}px)`, background: c.color }} />
            ))}
            <i className="iso-car-roof" />
            <i className="iso-car-light" />
            {/* 전방 지시선(S15P11E101-835). 2D 지도의 로봇 마커(원+노란 실선)를 본떠,
                차체 앞으로 뻗는 선으로 진행 방향을 한눈에 알린다. .iso-car 의
                rotate(--yaw) 를 그대로 상속하므로 실제 로봇 방향을 실시간으로 따라 돈다. */}
            <i className="iso-car-dir" />
          </div>
        </div>

        {/* 확정 점검 지점(S15P11E101-787). 운영 탭에서 승인한 AprilTag 지점을 벽 위에 핀으로
            세운다 — 2D 운영 지도의 마름모 태그와 같은 자리를 3D 개요에서도 짚어 준다.
            번호는 순찰이 도는 차례다. 핀은 씬 회전을 상쇄(빌보드)해 어느 각도에서 봐도
            번호가 정면으로 읽힌다. 바닥까지 내리는 기둥으로 어느 자리 위인지 알린다.
            enabled=false(순찰 제외) 지점은 흐리게 둔다 — 지우면 왜 안 도는지 알 수 없다. */}
        {points.map((p) => {
          const t = p?.target
          if (!t || !Number.isFinite(Number(t.x)) || !Number.isFinite(Number(t.y))) return null
          // 로봇 마커(aim)와 같은 변환을 쓴다(S15P11E101-789) — 다른 식을 쓰면 핀만 딴 자리에 선다.
          const px = worldToScenePx(plan as any, Number(t.x), Number(t.y), { w: src.w, h: src.h })
          return (
            <div
              key={p.pointId}
              className={`iso-insp${p.enabled === false ? ' off' : ''}`}
              style={{
                left: `${px.x}px`,
                top: `${px.y}px`,
                // 벽·로봇보다 높이 띄운다 — 개요에서 지점 핀이 벽에 묻히지 않게.
                '--rz': `${WALL_H * LAYER_STEP + 16}px`,
                // 씬 회전(rotateX(tilt) rotateZ(spin))의 역을 걸어 화면을 향하게 한다.
                '--face': `rotateZ(${-spin}deg) rotateX(${-tilt}deg)`,
              } as React.CSSProperties}
              title={`${p.name || `태그 ${p.tagId}`}${p.enabled === false ? ' (순찰 제외)' : ''}`}
            >
              <i className="iso-insp-drop" />
              <span className="iso-insp-pin"><b>{p.sequence}</b></span>
            </div>
          )
        })}
      </div>

      {/* 위치를 믿을 수 없으면 왜 마커가 없는지 말한다(S15P11E101-773).
          아무 말 없이 비어 있으면 로봇이 사라진 줄 안다. */}
      {unlocalized && (
        <div className="loc-wait" role="status">
          위치 확인 중
          <span>로컬라이제이션을 기다리는 중입니다 — 회복되면 로봇이 다시 표시됩니다.</span>
        </div>
      )}
      <button
        type="button"
        className={`mapview iso-reset${follow ? ' on' : ''}`}
        onClick={toggleFollow}
        aria-pressed={follow}
        title={follow ? '로봇 추종 중 — 눌러서 개요 시점으로' : '로봇을 따라가는 시점(자동차 게임처럼)'}
      >
        {follow ? '추종 중' : '로봇 추종'}
      </button>
    </div>
  )
}
