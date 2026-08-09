import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useLive } from '../../live/LiveContext.tsx'
import { useFleet } from '../../live/FleetContext.tsx'
import { eqId } from '../../live/equipments.ts'
import { isFloorplan } from '../../live/floorplan.ts'
import { buildPlanGrid, worldToScenePx, type PlanGrid } from '../../live/isoExtrude.ts'
import { H264VideoDecoder } from '../../live/h264Video.ts'
import { errMessage } from '../../live/errors.ts'
import { isMapFrame, localized } from '../../live/mappers.ts'
import type { InspectionPoint } from '../../live/contracts.d.ts'

// three.js 로 그리는 3D 지도 (S15P11E101-712).
//
// IsoMapView 는 같은 도면을 CSS transform(rotateX/rotateZ)으로 흉내 낸 2.5D 다 —
// 층을 40장 쌓아 기둥처럼 보이게 하는 연출이라, 각도를 눕히면 층 사이 이음새가 보이고
// 벽 옆면에 실제 빛이 들지 않는다. 여기서는 같은 벽 비트맵을 진짜 상자 지오메트리로
// 세우고 방향광 하나로 음영을 만든다. 데이터 입력은 완전히 같다(buildPlanGrid).
//
// 🔴 모든 오브젝트의 높이가 같다 [사용자 지침 2026-08-08].
//    IsoMapView 는 장애물을 벽의 45% 높이로 낮췄지만, 여기서는 벽·장애물 모두 WALL_H3 다.
//    구분은 높이가 아니라 색이 전담한다 — 벽 hsl(214 …) · 장애물 hsl(222 …).
//
// 🔴 씬은 밝다. 렌더러를 alpha:true 로 두고 clearColor 를 투명으로 해서,
//    뒤에 깔린 흰 무대가 그대로 비치게 한다. --bb-scene-dark 같은 어두운 판은
//    영상·SLAM 캔버스 전용이지 지도용이 아니다.

/** 씬의 긴 변 길이(three 월드 단위). 도면이 몇 미터든 이 크기로 정규화해 그린다. */
const SCENE_SPAN = 10
/** 모든 오브젝트의 높이. 긴 변의 6.2% — 압출 도면의 비율(약 31px/720px)과 같은 인상이다. */
const WALL_H3 = 0.62
/** 로봇 차체 크기(월드 단위). 도면 크기와 무관하게 일정하다 — 예전 CSS 마커도 고정 px 였다. */
const CAR = { w: 0.40, h: 0.26, d: 0.54 }

// 색은 IsoMapView 가 쓰던 두 계열을 그대로 옮긴 것이다.
const COL_WALL = new THREE.Color('hsl(214, 9%, 70%)')
const COL_OBST = new THREE.Color('hsl(222, 14%, 55%)')
const COL_FLOOR = new THREE.Color('#FBFBFD')
// (COL_ROBOT 초록 몸체는 실물형 흰검 모형으로 대체돼 지웠다 — S15P11E101-899)
const COL_HEAD = new THREE.Color('#C9A26A')    // 주의색 — 진행 방향 지시선
// 빛기둥 색 — 옛 .iso-robot::before(app.css) 의 rgba 값을 그대로 옮긴 것이다.
const BEAM_RGB = '61,220,151'      // 정상 — rgba(61,220,151,*)
const BEAM_RGB_OFF = '160,170,180' // 오프라인 — rgba(160,170,180,*)

/**
 * 위로 갈수록 진해지는 세로 그라디언트 텍스처.
 *
 * 옛 CSS 의 `linear-gradient(0deg, rgba(…,0), rgba(…,.5))` 와 같은 모양이다 —
 * 아래는 완전 투명, 위로 갈수록 짙어진다. 캔버스 한 장을 만들어 스프라이트에 입힌다.
 */
function buildBeamTexture(rgb: string, maxAlpha: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, c.height, 0, 0)   // 아래(y=height) → 위(y=0)
  g.addColorStop(0, `rgba(${rgb},0)`)
  g.addColorStop(1, `rgba(${rgb},${maxAlpha})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, c.width, c.height)
  const tex = new THREE.CanvasTexture(c)
  tex.needsUpdate = true
  return tex
}

/** 윗면만 이만큼 밝힌다. 폭이 넓으면 벽이 발광체처럼 보인다(748 의 교훈). */
const TOP_LIGHTEN = 0.055

// nav 자세가 이 시간 안에 들어왔다면 텔레메트리로 덮지 않는다.
// 텔레메트리는 1Hz 라, 3Hz 인 nav 와 섞으면 마커가 앞뒤로 떨린다.
const NAV_FRESH_MS = 2500

/** 상자 6면 — [바깥 법선, 바깥에서 봤을 때 반시계인 네 꼭짓점]. 인덱스는 0,1,2 / 0,2,3. */
const FACES: { n: [number, number, number], v: [number, number, number][], top?: boolean }[] = [
  { n: [1, 0, 0], v: [[.5, -.5, .5], [.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5]] },
  { n: [-1, 0, 0], v: [[-.5, -.5, -.5], [-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5]] },
  { n: [0, 1, 0], v: [[-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5], [-.5, .5, -.5]], top: true },
  { n: [0, -1, 0], v: [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, .5]] },
  { n: [0, 0, 1], v: [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]] },
  { n: [0, 0, -1], v: [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]] },
]

interface Rect { x: number, y: number, w: number, h: number }

/**
 * 켜진 칸을 큰 직사각형으로 묶는다 (greedy).
 *
 * 도면 격자는 최대 720×720 이라 칸마다 상자를 세우면 수만 개가 된다. 가로로 이어 붙인
 * 뒤 같은 폭이 이어지는 동안 아래로 넓히면, 방 하나짜리 벽이 상자 몇 개로 줄어든다 —
 * 정점 수가 줄 뿐 아니라 상자 사이 경계선이 사라져 벽이 한 덩어리로 읽힌다.
 */
function mergeRects(bits: Uint8Array, w: number, h: number): Rect[] {
  const used = new Uint8Array(bits.length)
  const out: Rect[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!bits[i] || used[i]) continue
      let rw = 1
      while (x + rw < w && bits[i + rw] && !used[i + rw]) rw++
      let rh = 1
      grow: while (y + rh < h) {
        const row = (y + rh) * w + x
        for (let k = 0; k < rw; k++) if (!bits[row + k] || used[row + k]) break grow
        rh++
      }
      for (let yy = 0; yy < rh; yy++) {
        const s = (y + yy) * w + x
        used.fill(1, s, s + rw)
      }
      out.push({ x, y, w: rw, h: rh })
    }
  }
  return out
}

/**
 * 직사각형 목록 → 상자 하나로 합친 지오메트리.
 *
 * three 의 mergeGeometries 를 쓰지 않고 버퍼를 직접 채운다 — 상자 수천 개 분량의
 * BufferGeometry 객체를 만들었다 버리는 비용이 없고, 윗면만 밝히는 것도
 * 정점 색으로 한 번에 처리된다(재질을 6개 쓰면 draw call 이 6배가 된다).
 */
function buildMerged(rects: Rect[], color: THREE.Color, px: (x: number) => number, pz: (y: number) => number, unit: number) {
  const quads = rects.length * 6
  const pos = new Float32Array(quads * 4 * 3)
  const nor = new Float32Array(quads * 4 * 3)
  const col = new Float32Array(quads * 4 * 3)
  const idx = new Uint32Array(quads * 6)
  const top = color.clone().offsetHSL(0, 0, TOP_LIGHTEN)
  let vi = 0, ii = 0
  for (const r of rects) {
    const cx = px(r.x + r.w / 2)
    const cz = pz(r.y + r.h / 2)
    const sx = r.w * unit
    const sz = r.h * unit
    for (const f of FACES) {
      const c = f.top ? top : color
      const base = vi
      for (const v of f.v) {
        pos[vi * 3] = cx + v[0] * sx
        pos[vi * 3 + 1] = WALL_H3 / 2 + v[1] * WALL_H3
        pos[vi * 3 + 2] = cz + v[2] * sz
        nor[vi * 3] = f.n[0]; nor[vi * 3 + 1] = f.n[1]; nor[vi * 3 + 2] = f.n[2]
        col[vi * 3] = c.r; col[vi * 3 + 1] = c.g; col[vi * 3 + 2] = c.b
        vi++
      }
      idx[ii++] = base; idx[ii++] = base + 1; idx[ii++] = base + 2
      idx[ii++] = base; idx[ii++] = base + 2; idx[ii++] = base + 3
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  return g
}

// 경보 말풍선 속 실시간 전면 영상 (S15P11E101-883).
// 카메라 탭의 파이프라인(LiveSimBridge → SimContext 캔버스)은 전역 캔버스 ref 에 묶여
// 있어 재사용할 수 없다 — 같은 디코드 분기(H264 envelope / base64 JPEG)만 축약 이식해
// 자체 캔버스에 그린다. 프레임 원본은 동일한 onVideoFrame(/topic/video) 구독이다.
function AlertLiveVideo() {
  const { onVideoFrame } = useLive()
  const cvRef = useRef<HTMLCanvasElement | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const draw = (src: CanvasImageSource, sw: number, sh: number) => {
      const cv = cvRef.current
      const g = cv?.getContext('2d')
      if (!cv || !g || !sw || !sh) return
      // cover — 프레임 비율이 캔버스와 달라도 여백 없이 채운다
      const s = Math.max(cv.width / sw, cv.height / sh)
      const dw = sw * s
      const dh = sh * s
      g.drawImage(src, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh)
      setSeen(true)   // 같은 값이면 React 가 무시한다 — 매 프레임 불러도 리렌더 없음
    }
    const decoder = new H264VideoDecoder((frame) => draw(frame, frame.width, frame.height))
    const img = new Image()
    img.onload = () => draw(img, img.naturalWidth, img.naturalHeight)
    const off = onVideoFrame((channel: string, frame: any) => {
      if (channel !== 'FRONT') return
      if (frame instanceof Uint8Array) { decoder.push(frame); return }
      if (frame?.data) img.src = `data:image/${frame.format || 'jpeg'};base64,${frame.data}`
    })
    return () => { off(); decoder.close() }
  }, [onVideoFrame])
  return (
    <div className="three-alert-video">
      <canvas ref={cvRef} width={224} height={126} />
      {!seen && <span>전면 카메라 수신 대기…</span>}
    </div>
  )
}

export default function ThreeMapView({ zoomFactor = 1, points = [] }: { zoomFactor?: number, points?: InspectionPoint[] }) {
  const { plan, connected, onNavUpdate, robotOnline, telemetry, alerts } = useLive()
  const { equipments } = useFleet()
  // 텔레메트리가 map 이 아니라고 말하면 그린 것을 거둔다(S15P11E101-773)
  const unlocalized = !!telemetry?.location && !isMapFrame(telemetry.location)

  const [grid, setGrid] = useState<PlanGrid | null>(null)
  // 씬을 새로 세울 때마다 올라간다. <canvas> 의 key 로 써서 **캔버스 자체를 새로 만든다** —
  // 이유는 아래 씬 이펙트의 정리 단계에 있는 forceContextLoss() 다(자세한 설명은 그쪽 주석).
  const [sceneSeq, setSceneSeq] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [follow, setFollow] = useState(false)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 핀 DOM. 3D 오브젝트가 아니라 HTML 오버레이라, 어느 각도에서 봐도 번호가 정면으로 읽힌다.
  const pinEls = useRef(new Map<string, HTMLDivElement>())

  // 렌더 루프가 매 프레임 읽는 값들. state 로 두면 프레임마다 React 가 다시 그린다.
  const followRef = useRef(false)
  followRef.current = follow
  const zoomFactorRef = useRef(zoomFactor)
  const planRef = useRef(plan)
  planRef.current = plan
  const gridRef = useRef(grid)
  gridRef.current = grid
  // 받은 값(목표)과 화면에 그리는 값(현재)을 나눠 둔다 — 사이를 보간한다
  const targetRef = useRef<{ x: number, y: number, yaw: number } | null>(null)
  const shownRef = useRef<{ x: number, y: number, yaw: number } | null>(null)
  const navAtRef = useRef(0)
  const offRef = useRef(false)
  offRef.current = robotOnline === false
  // 씬 안에서 카메라를 조작하는 손잡이. 버튼(줌 배율)에서도 쓴다.
  const apiRef = useRef<{ setZoom: (f: number) => void, reset: () => void } | null>(null)

  // 벽 비트맵 만들기. 도면이 바뀌면(FLOORPLAN_READY 로 새 도면이 오면) 다시 만든다.
  // RAW 점유격자는 세우지 않는다 — 미탐색 회색이 벽으로 오분류돼 도면 전체가 기둥이 된다.
  useEffect(() => {
    if (!plan?.img || !isFloorplan(plan)) { setGrid(null); setError(null); return }
    setBusy(true); setError(null)
    try {
      setGrid(buildPlanGrid(plan.img))
      // 같은 커밋에서 함께 올린다 — 새 격자가 화면에 붙을 때 캔버스도 같이 새것이 된다.
      setSceneSeq((n) => n + 1)
    } catch (e) {
      setGrid(null); setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }, [plan])

  // 점검 지점의 씬 좌표. 매 프레임 다시 계산하지 않는다 — 지점은 자주 바뀌지 않는다.
  // enabled=false(순찰 제외) 지점도 남긴다. 지우면 왜 안 도는지 알 수 없다(S15P11E101-787).
  const pins = useMemo(() => {
    if (!plan || !grid) return [] as { id: string, x: number, y: number, seq: number, off: boolean, title: string }[]
    return points.flatMap((p) => {
      const t = p?.target
      if (!t || !Number.isFinite(Number(t.x)) || !Number.isFinite(Number(t.y))) return []
      // 로봇 마커와 같은 변환을 쓴다(S15P11E101-789) — 다른 식을 쓰면 핀만 딴 자리에 선다.
      const px = worldToScenePx(plan as any, Number(t.x), Number(t.y), { w: grid.w, h: grid.h })
      return [{
        id: p.pointId,
        x: px.x,
        y: px.y,
        seq: p.sequence,
        off: p.enabled === false,
        title: `${p.name || `태그 ${p.tagId}`}${p.enabled === false ? ' (순찰 제외)' : ''}`,
      }]
    })
  }, [points, plan, grid])
  const pinsRef = useRef(pins)
  pinsRef.current = pins

  // 좌표 없는 경보를 로봇 위치에 고정한다 (S15P11E101-890).
  // 로봇이 자기 위치에서 감지한 화재는 alert 에 x,y 가 실려 오지 않는다 — 그때는 그 순간
  // 로봇이 서 있던 자리를 쓴다. 경보 도착 시점의 씬 좌표를 _id 별로 한 번만 붙잡아 둔다.
  // (매 프레임 로봇 좌표를 따라가면, 로봇이 그 뒤 움직였을 때 화재 마커가 같이 끌려간다 —
  //  화재는 발생한 그 자리에 남아야 한다.) 씬 px 로 저장하므로 worldToScenePx 를 거치지 않는다.
  const [anchored, setAnchored] = useState<Record<number, { x: number, y: number }>>({})
  useEffect(() => {
    const g = gridRef.current
    const pl = planRef.current
    if (!g || !pl) return
    setAnchored((prev) => {
      let next = prev
      for (const a of alerts as any[]) {
        if (a?.type !== 'FIRE' && a?.type !== 'OVERHEAT') continue
        const id = a?._id as number | undefined
        if (id == null || next[id]) continue
        // 경보 자체 좌표나 설비 좌표가 있으면 그쪽을 쓰므로 고정하지 않는다.
        const hasXY = Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))
        const eq: any = a.equipmentId ? equipments.find((e: any) => eqId(e) === a.equipmentId) : null
        const hasEq = eq && Number.isFinite(Number(eq.x)) && Number.isFinite(Number(eq.y))
        if (hasXY || hasEq) continue
        // 로봇의 현재 씬 위치. 받은 목표값(targetRef)을 우선하고, 없으면 그리는 값(shownRef).
        const pos = targetRef.current || shownRef.current
        if (!pos) continue   // 아직 로봇 자세를 못 받았다 — 다음 갱신에 다시 시도
        if (next === prev) next = { ...prev }
        next[id] = { x: pos.x, y: pos.y }
      }
      return next
    })
  }, [alerts, equipments])

  // ── 화재/과열 경보 마커 (S15P11E101-883) ─────────────────────────────
  // /topic/alerts 의 x,y 는 map 프레임 미터다 — 점검 핀과 같은 변환을 거친다.
  // OVERHEAT 는 좌표 없이 equipmentId 만 올 수 있어 설비 좌표로, 그것도 없으면
  // 로봇 위치(anchored, 씬 px)로 폴백한다(S15P11E101-890).
  const alertPins = useMemo(() => {
    if (!plan || !grid) {
      return [] as { id: number, kind: 'fire' | 'heat', x: number, y: number, time: string, title: string, sub: string | null }[]
    }
    return alerts.flatMap((a: any) => {
      if (a?.type !== 'FIRE' && a?.type !== 'OVERHEAT') return []
      const id = a._id as number
      let sx: number, sy: number
      let wx = Number(a.x)
      let wy = Number(a.y)
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
        const eq: any = a.equipmentId ? equipments.find((e: any) => eqId(e) === a.equipmentId) : null
        wx = Number(eq?.x)
        wy = Number(eq?.y)
      }
      if (Number.isFinite(wx) && Number.isFinite(wy)) {
        const p = worldToScenePx(plan as any, wx, wy, { w: grid.w, h: grid.h })
        sx = p.x; sy = p.y
      } else if (anchored[id]) {
        // 좌표가 없어 로봇 위치에 고정한 경보 — 이미 씬 px 다.
        sx = anchored[id].x; sy = anchored[id].y
      } else {
        return []   // 위치를 아직 모른다 — 로봇 자세가 들어오면 anchored 가 채워져 다시 그려진다
      }
      const t = a.timestamp ? new Date(a.timestamp) : null
      const heat = a.type === 'OVERHEAT'
      return [{
        id,
        kind: (heat ? 'heat' : 'fire') as 'fire' | 'heat',
        x: sx,
        y: sy,
        time: t && !Number.isNaN(t.getTime()) ? t.toTimeString().slice(0, 8) : '—',
        title: heat ? '과열 감지' : '화재 발생',
        sub: heat
          ? `${a.equipmentId || '설비'}${Number.isFinite(a.temperature) ? ` · ${Number(a.temperature).toFixed(1)}℃` : ''}`
          : null,
      }]
    })
  }, [alerts, equipments, plan, grid, anchored])
  const alertPinsRef = useRef(alertPins)
  alertPinsRef.current = alertPins
  // 열려 있는 말풍선(경보 _id). 마커를 다시 누르거나 ×로 닫는다.
  const [alertSel, setAlertSel] = useState<number | null>(null)
  const alertSelRef = useRef(alertSel)
  alertSelRef.current = alertSel
  const alertEls = useRef(new Map<number, HTMLElement>())
  const popEl = useRef<HTMLDivElement | null>(null)
  // 보던 경보가 목록에서 사라지면(닫힘/해제) 말풍선도 닫는다 — 유령 대화상자를 남기지 않는다
  useEffect(() => {
    if (alertSel != null && !alertPins.some((p) => p.id === alertSel)) setAlertSel(null)
  }, [alertPins, alertSel])

  // 수신 자세 표본 버퍼(S15P11E101-895) — 스냅샷 보간용. 최신 표본만 좇는 지수 보간은
  // 수신(1~3Hz) 직후 빠르게 도착해 다음 수신까지 서 있는 stop-and-go 가 됐다 — 로봇이
  // 뚝뚝 끊겨 보이고, 이동 중에는 방향도 반 박자 계단식으로 틀어져 2D 와 달라 보였다.
  // 대신 표본 사이를 실제 시간축으로 따라가면 위치·방향이 로봇의 실제 궤적 그대로 흐른다.
  const poseBufRef = useRef<{ x: number, y: number, yaw: number, at: number }[]>([])

  // 목표 자세를 옮긴다. 자리를 계산하는 식은 한 곳에 둔다.
  const aim = (x: number, y: number, yaw: number) => {
    const p = planRef.current
    const g = gridRef.current
    if (!p || !g) return
    // 씬 픽셀 공간은 격자 셀이 아니라 도면 이미지 픽셀이다(S15P11E101-789).
    const px = worldToScenePx(p as any, x, y, { w: g.w, h: g.h })
    targetRef.current = { x: px.x, y: px.y, yaw: Number.isFinite(yaw) ? yaw : 0 }
    const buf = poseBufRef.current
    buf.push({ ...targetRef.current, at: performance.now() })
    if (buf.length > 4) buf.shift()   // 보간에는 최근 두 표본이면 충분하다 — 오래 쌓을 이유가 없다
  }

  // 1순위: /topic/nav 의 자세. 3Hz 로 오고 스캔과 같은 시점이라 가장 정확하다.
  useEffect(() => onNavUpdate((nav: any) => {
    const pose = nav?.pose
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return
    navAtRef.current = Date.now()
    aim(pose.x, pose.y, Number(pose.yaw))
  }), [onNavUpdate])

  // 2순위: /topic/robots 텔레메트리의 location(S15P11E101-745 계약).
  // nav 노드가 죽어도 로봇은 위치를 계속 보낸다 — 그때 마커가 사라지면
  // '로봇이 어디 있는지 모른다' 가 아니라 '로봇이 없다' 로 잘못 읽힌다.
  useEffect(() => {
    const loc = telemetry?.location
    // 로컬라이즈되지 않은 좌표는 map 이 아니다 — 도면 위에 그리면 엉뚱한 자리에 찍힌다(773)
    if (!loc || !localized(loc)) return
    if (Date.now() - navAtRef.current < NAV_FRESH_MS) return
    aim(Number(loc.x), Number(loc.y), Number(loc.yaw))
  }, [telemetry])

  // 도면이 바뀌면 이전 자세는 다른 좌표계의 값이다 — 버린다.
  useEffect(() => { targetRef.current = null; shownRef.current = null; poseBufRef.current = [] }, [plan])

  // 위치를 믿을 수 없으면 로봇을 아예 지운다(S15P11E101-773).
  // 흐리게 두지 않는다 — 흐린 마커도 '저기 있다' 로 읽힌다. 모르면 안 그린다.
  useEffect(() => {
    if (unlocalized) { targetRef.current = null; shownRef.current = null; poseBufRef.current = [] }
  }, [unlocalized])

  // ── 씬 ──────────────────────────────────────────────────────────────
  // grid 가 준비된 뒤에만 캔버스가 렌더되므로, 이 이펙트는 캔버스가 붙은 뒤에 돈다.
  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host || !grid) return

    const { w, h, wall, obst } = grid
    // 도면 픽셀 → 월드 단위. 긴 변을 SCENE_SPAN 으로 맞춰 어느 도면이든 같은 크기로 본다.
    const unit = SCENE_SPAN / Math.max(w, h)
    const px = (x: number) => (x - w / 2) * unit
    const pz = (y: number) => (y - h / 2) * unit

    const scene = new THREE.Scene()
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    // 🔴 투명 — 뒤의 흰 무대가 그대로 비친다. 지도 씬을 어둡게 덮지 않기 위해서다.
    renderer.setClearColor(0x000000, 0)
    renderer.shadowMap.enabled = true
    // PCFSoftShadowMap 은 폐기 예고가 붙어(콘솔 경고) 내부적으로 PCF 로 떨어진다 — 직접 쓴다.
    renderer.shadowMap.type = THREE.PCFShadowMap

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200)
    // 기본 시점의 **방위는 0** 이다 — 벽이 화면 축과 나란히 선다.
    //
    // 🔴 시안(map-v6.html)은 대각(x·z 를 둘 다 준 코너 시점)이었는데, 그 사이 머지된
    // S15P11E101-855 가 `IsoMapView` 의 `SPIN_BASE` 를 -24° → 0° 로 바꾸며
    // "기본 방위를 수평(벽이 화면 축과 나란함)으로 둔다 — 이전의 대각 제거" 라고 못박았다.
    // 파일이 달라 git 이 충돌로 잡아 주지 못하는 자리라, 여기서 손으로 맞춘다.
    // 대각으로 보고 싶으면 사용자가 드래그해서 돌리면 된다 — 기본값의 문제다.
    const VIEW_DIR = new THREE.Vector3(0, 0.62, 0.78).normalize()

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    // 바닥 아래로 내려가면 도면이 뒤집혀 보인다 — 위쪽 반구로 제한한다.
    controls.minPolarAngle = 0.15
    controls.maxPolarAngle = Math.PI / 2 - 0.06
    controls.minDistance = SCENE_SPAN * 0.5
    controls.maxDistance = SCENE_SPAN * 4
    controls.enablePan = false

    // 빛 — 관제 화면은 밝은 씬이다. 위에서 부드럽게 드는 빛 하나 + 하늘/바닥 반사.
    // 대비를 세게 주면 벽이 발광체처럼 보인다(IsoMapView 주석의 교훈).
    scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe1e8, 1.05))
    const key = new THREE.DirectionalLight(0xffffff, 1.35)
    key.position.set(SCENE_SPAN * 0.65, SCENE_SPAN * 1.2, SCENE_SPAN * 0.7)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    const half = SCENE_SPAN * 0.8
    key.shadow.camera.left = -half; key.shadow.camera.right = half
    key.shadow.camera.top = half; key.shadow.camera.bottom = -half
    key.shadow.camera.near = 1; key.shadow.camera.far = SCENE_SPAN * 4
    key.shadow.radius = 5
    key.shadow.bias = -0.0012
    scene.add(key)

    // 바닥 — 살짝 두께가 있는 흰 판. 그림자를 받아 씬이 떠 있는 것처럼 보이게 한다.
    // 도면 그림을 깔지 않는 이유는 IsoMapView 와 같다(S15P11E101-777).
    const floorGeo = new THREE.BoxGeometry(w * unit + 0.4, 0.10, h * unit + 0.4)
    const floorMat = new THREE.MeshLambertMaterial({ color: COL_FLOOR })
    const floor = new THREE.Mesh(floorGeo, floorMat)
    floor.position.y = -0.05
    floor.receiveShadow = true
    scene.add(floor)

    // 벽·장애물 — 🔴 높이가 같다. 구분은 색이 한다.
    const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true })
    const geos: THREE.BufferGeometry[] = [floorGeo]
    const wallRects = mergeRects(wall, w, h)
    if (wallRects.length) {
      const g = buildMerged(wallRects, COL_WALL, px, pz, unit)
      const m = new THREE.Mesh(g, solidMat)
      m.castShadow = true; m.receiveShadow = true
      scene.add(m); geos.push(g)
    }
    const obstRects = grid.obstacleRatio > 0 ? mergeRects(obst, w, h) : []
    if (obstRects.length) {
      const g = buildMerged(obstRects, COL_OBST, px, pz, unit)
      const m = new THREE.Mesh(g, solidMat)
      m.castShadow = true; m.receiveShadow = true
      scene.add(m); geos.push(g)
    }

    // 로봇 — 바닥을 달리는 물건이다. 벽 위에 띄우지 않는다(2026-08-07 의 교훈).
    //
    // 실물 오린카를 닮은 순찰차 모형(S15P11E101-899) — 흰 차체 + 검정 디테일.
    // 이전의 앞뒤가 같은 초록 박스는 진행 방향이 모양으로 읽히지 않았다. 실물과 같은
    // 자리에 전면 카메라(검정, 앞 = 로컬 -z)와 상단 라이다(검정 원통), 바퀴(검정)를
    // 붙여 어느 각도에서도 앞이 읽힌다. 파랑 LED 는 실물 카메라의 전원 표시등이다.
    const robot = new THREE.Group()
    const bodyMat = new THREE.MeshLambertMaterial({ color: '#F7F8FA' })   // 흰 차체
    const darkMat = new THREE.MeshLambertMaterial({ color: '#16181d' })   // 라이다·카메라·바퀴
    const ledMat = new THREE.MeshBasicMaterial({ color: '#3D8BFF' })      // 카메라 LED — 발광이라 Basic
    const robotMats: (THREE.MeshLambertMaterial | THREE.MeshBasicMaterial)[] = [bodyMat, darkMat, ledMat]
    const robotGeos: THREE.BufferGeometry[] = []
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rotZ = 0) => {
      robotGeos.push(geo)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      if (rotZ) m.rotation.z = rotZ
      m.castShadow = true
      robot.add(m)
      return m
    }
    // 바퀴 — 뒤가 크고 앞이 작다(실물 그대로). 차체는 바퀴 위에 얹힌다.
    const WHEEL_R = 0.075
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.05, 18)
    const casterGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.04, 14)
    part(wheelGeo, darkMat, -(CAR.w / 2 + 0.02), WHEEL_R, CAR.d * 0.26, Math.PI / 2)
    part(wheelGeo.clone(), darkMat, CAR.w / 2 + 0.02, WHEEL_R, CAR.d * 0.26, Math.PI / 2)
    part(casterGeo, darkMat, -(CAR.w / 2 + 0.015), 0.045, -CAR.d * 0.3, Math.PI / 2)
    part(casterGeo.clone(), darkMat, CAR.w / 2 + 0.015, 0.045, -CAR.d * 0.3, Math.PI / 2)
    // 차체 — 흰 상자. 바닥에서 살짝 띄워 바퀴로 서 있는 인상을 만든다.
    const BODY_LIFT = 0.03
    const bodyGeo = new THREE.BoxGeometry(CAR.w, CAR.h, CAR.d)
    part(bodyGeo, bodyMat, 0, BODY_LIFT + CAR.h / 2, 0)
    // 윗면 검정 홈 + 라이다 원통 2단 — 실물의 상단 라이다 타워.
    const wellGeo = new THREE.BoxGeometry(CAR.w * 0.52, 0.022, CAR.d * 0.4)
    part(wellGeo, darkMat, 0, BODY_LIFT + CAR.h + 0.011, 0)
    const lidarBaseGeo = new THREE.CylinderGeometry(0.055, 0.07, 0.05, 20)
    part(lidarBaseGeo, darkMat, 0, BODY_LIFT + CAR.h + 0.045, 0)
    const lidarTopGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.075, 20)
    part(lidarTopGeo, darkMat, 0, BODY_LIFT + CAR.h + 0.105, 0)
    // 전면 카메라 모듈(검정) — 차체 앞(-z)에 돌출. 모양만으로 앞이 읽히는 핵심이다.
    const camGeo = new THREE.BoxGeometry(0.17, 0.085, 0.07)
    part(camGeo, darkMat, 0, BODY_LIFT + CAR.h * 0.42, -(CAR.d / 2 + 0.028))
    const ledGeo = new THREE.BoxGeometry(0.02, 0.02, 0.012)
    part(ledGeo, ledMat, -0.055, BODY_LIFT + CAR.h * 0.42, -(CAR.d / 2 + 0.066))
    // 진행 방향 지시선 — 2D 지도 마커의 노란 실선과 같은 뜻·같은 계열의 색이다.
    // 차체 로컬 -z 가 앞이다.
    const headGeo = new THREE.BoxGeometry(0.055, 0.03, CAR.d)
    const headMat = new THREE.MeshBasicMaterial({ color: COL_HEAD })
    robotMats.push(headMat)
    const head = new THREE.Mesh(headGeo, headMat)
    head.position.set(0, 0.045, -CAR.d)
    robot.add(head)

    // 빛기둥(S15P11E101-712) — 옛 IsoMapView(CSS 2.5D) 의 `.iso-robot::before` 를 그대로
    // 옮긴 것이다. three.js 는 깊이 버퍼가 정확해 벽 뒤 로봇이 그냥 사라지므로,
    // depthTest 를 꺼서 벽에 가려도 자리를 잃지 않게 한다. 로봇은 씬 안의 물체라야
    // 벽과 같은 조명·원근을 받는다 — HTML 오버레이 핀(점검 지점)과는 성격이 다르다.
    const beamTex = buildBeamTexture(BEAM_RGB, 0.5)
    const beamTexOff = buildBeamTexture(BEAM_RGB_OFF, 0.4)
    const beamMat = new THREE.SpriteMaterial({
      map: beamTex, transparent: true, depthTest: false, depthWrite: false,
    })
    const beam = new THREE.Sprite(beamMat)
    beam.center.set(0.5, 0)               // 스프라이트 기준점을 바닥(아래쪽)으로 — 위로 솟는 기둥
    const BEAM_H = WALL_H3 * 1.25          // 벽보다 살짝 높게(옛 38px vs 벽 31px 비율과 같다)
    const BEAM_W = 0.035
    beam.scale.set(BEAM_W, BEAM_H, 1)
    beam.position.set(0, 0, 0)             // 로봇 바닥(차체 그룹 원점)에서 솟는다
    beam.renderOrder = 999                 // 벽·차체보다 나중에 그려 가려지지 않게 한다
    robot.add(beam)

    robot.visible = false
    scene.add(robot)

    // 카메라 자동 프레이밍. 세로 FOV 와 가로 중 더 빡빡한 쪽을 기준으로 잡아야
    // 어느 화면 비율에서도 도면이 잘리지 않는다.
    const ROOM_R = Math.hypot(w * unit, h * unit) / 2 + 0.6
    let fitDist = SCENE_SPAN
    const fitCamera = () => {
      const vFov = THREE.MathUtils.degToRad(camera.fov)
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
      // 0.72 — ROOM_R 은 도면을 감싸는 '구' 의 반지름이라, 높이가 거의 없는 납작한 도면에는
      // 과하게 크다. 그대로 외접시키면 화면 절반이 빈 여백이 된다(브라우저에서 실제로 그랬다).
      // 눕혀 봐도 네 벽이 화면에 남는 선까지 당긴 값이다.
      fitDist = ROOM_R / Math.sin(Math.min(vFov, hFov) / 2) * 0.72
      controls.minDistance = Math.min(controls.minDistance, fitDist * 0.35)
      controls.maxDistance = Math.max(controls.maxDistance, fitDist * 2.2)
      controls.target.set(0, 0, 0)
      camera.position.copy(controls.target).addScaledVector(VIEW_DIR, fitDist / Math.max(0.2, zoomFactorRef.current))
      controls.update()
    }

    const resize = () => {
      const r = host.getBoundingClientRect()
      if (!r.width || !r.height) return
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
      renderer.setSize(r.width, r.height, false)
      camera.aspect = r.width / r.height
      camera.updateProjectionMatrix()
      fitCamera()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    // 🔴 원점이 아니라 타깃 기준으로 당긴다. 추종 중에는 타깃이 로봇이므로,
    //    원점 기준으로 곱하면 시점이 옆으로 밀린다.
    const distTo = (d: number) => {
      const v = camera.position.clone().sub(controls.target)
      const len = THREE.MathUtils.clamp(d, controls.minDistance, controls.maxDistance)
      camera.position.copy(controls.target).addScaledVector(v.normalize(), len)
    }
    apiRef.current = {
      setZoom: (f: number) => distTo(fitDist / Math.max(0.2, f)),
      reset: () => fitCamera(),
    }

    const tmp = new THREE.Vector3()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)

      // 로봇 자세 — 스냅샷 보간(S15P11E101-895). 수신(1~3Hz) 표본 사이를 실제 시간축으로
      // 따라간다: 표시 시점을 최근 수신 간격만큼 뒤로 물리면, 다음 표본이 도착할 즈음
      // 직전 구간을 다 걸어 로봇이 멈췄다 튀지 않는다 — 위치도 방향도 실제 궤적처럼 흐른다.
      // (예전 지수 보간(k=0.18)은 수신 직후 목표에 빨리 붙고 다음 수신까지 서 있어
      //  stop-and-go 로 끊겨 보였고, 이동 중 방향이 계단식이라 2D 와 어긋나 보였다.)
      const t = targetRef.current
      if (!t) {
        robot.visible = false
        shownRef.current = null
      } else {
        const buf = poseBufRef.current
        const last = buf[buf.length - 1]
        const prev = buf[buf.length - 2]
        // 표시 지연 = 최근 수신 간격(150ms~1.2s 클램프). 간격보다 덜 물리면 구간을 다
        // 걷기 전에 표본이 바닥나 멈칫하고, 너무 물리면 화면이 로봇을 그만큼 늦게 따라간다.
        const gap = prev ? Math.min(1200, Math.max(150, last.at - prev.at)) : 333
        const rt = performance.now() - gap
        // rt 를 감싸는 두 표본을 찾아 선형 보간한다. 못 찾으면(수신이 끊겼으면) 마지막
        // 표본에 그대로 선다 — 없는 미래를 지어내 외삽하지 않는다.
        let pose = { x: last.x, y: last.y, yaw: last.yaw }
        for (let i = buf.length - 1; i > 0; i--) {
          const b = buf[i - 1]
          const a = buf[i]
          if (rt >= b.at && rt <= a.at) {
            const f = a.at === b.at ? 1 : (rt - b.at) / (a.at - b.at)
            let dy = a.yaw - b.yaw
            while (dy > Math.PI) dy -= Math.PI * 2   // yaw 는 -π~π 를 오간다 — 짧은 쪽으로 감는다
            while (dy < -Math.PI) dy += Math.PI * 2
            pose = { x: b.x + (a.x - b.x) * f, y: b.y + (a.y - b.y) * f, yaw: b.yaw + dy * f }
            break
          }
        }
        if (rt < (buf[0]?.at ?? 0)) pose = { x: buf[0].x, y: buf[0].y, yaw: buf[0].yaw }
        shownRef.current = pose
        const v = shownRef.current
        robot.visible = true
        robot.position.set(px(v.x), 0, pz(v.y))
        // 차체 로컬 -z 가 앞이다. 월드 yaw 의 진행 방향은 씬 픽셀 기준 (cos yaw, -sin yaw)
        // 이고 그것이 (x, z) 축이므로, 로컬 -z 를 그 방향으로 보내는 회전은 yaw - π/2 다.
        // 2D 지도 화살표와 같은 규약이다.
        robot.rotation.y = v.yaw - Math.PI / 2
        // 로봇이 꺼져 있으면 흐린다. 지우지는 않는다 — 마지막으로 알던 자리는 남아야
        // 어디서 멈췄는지 알 수 있다.
        const off = offRef.current
        for (const m of robotMats) { m.opacity = off ? 0.42 : 1; m.transparent = off }
        beamMat.map = off ? beamTexOff : beamTex
        beamMat.needsUpdate = true
      }

      // 추종 시점 — 로봇 뒤 위쪽에서 진행 방향을 보고 따라간다(자동차 게임 시점).
      // 로봇이 없으면 아무것도 몰지 않는다 — 없는 자리를 좇지 않는다.
      const v2 = shownRef.current
      if (followRef.current && v2) {
        const d = camera.position.distanceTo(controls.target)
        controls.target.set(px(v2.x), WALL_H3 * 0.5, pz(v2.y))
        // 차체 앞 방향(월드). rotation.y = θ 일 때 로컬 -z 는 (-sin θ, 0, -cos θ) 다.
        const th = robot.rotation.y
        camera.position.set(
          controls.target.x + Math.sin(th) * d * 0.78,
          controls.target.y + d * 0.62,
          controls.target.z + Math.cos(th) * d * 0.78,
        )
      }

      controls.update()
      renderer.render(scene, camera)

      // 점검 지점 핀 — 월드 좌표를 화면에 투영해 위치만 갱신한다. 궤도를 돌려도
      // 핀이 붙어 다니면서, 번호 배지는 늘 정면으로 읽힌다.
      const r = host.getBoundingClientRect()
      for (const p of pinsRef.current) {
        const el = pinEls.current.get(p.id)
        if (!el) continue
        tmp.set(px(p.x), WALL_H3 + 0.42, pz(p.y)).project(camera)
        // 카메라 뒤로 돌아가면 숨긴다 — 안 그러면 반대편에 유령처럼 찍힌다.
        el.style.visibility = tmp.z > 1 ? 'hidden' : ''
        el.style.left = `${(tmp.x * 0.5 + 0.5) * r.width}px`
        el.style.top = `${(-tmp.y * 0.5 + 0.5) * r.height}px`
      }

      // 화재/과열 경보 마커 + 열린 말풍선 — 점검 핀과 같은 투영이다(S15P11E101-883).
      for (const p of alertPinsRef.current) {
        const el = alertEls.current.get(p.id)
        if (!el) continue
        tmp.set(px(p.x), WALL_H3 + 0.5, pz(p.y)).project(camera)
        const hidden = tmp.z > 1
        const left = `${(tmp.x * 0.5 + 0.5) * r.width}px`
        const top = `${(-tmp.y * 0.5 + 0.5) * r.height}px`
        el.style.visibility = hidden ? 'hidden' : ''
        el.style.left = left
        el.style.top = top
        // 말풍선은 마커와 같은 기준점에 붙인다 — CSS transform 이 위로 띄운다
        if (alertSelRef.current === p.id && popEl.current) {
          popEl.current.style.visibility = hidden ? 'hidden' : ''
          popEl.current.style.left = left
          popEl.current.style.top = top
        }
      }
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      apiRef.current = null
      for (const g of geos) g.dispose()
      for (const g of robotGeos) g.dispose()
      headGeo.dispose()
      solidMat.dispose(); floorMat.dispose()
      for (const m of robotMats) m.dispose()
      beamMat.dispose(); beamTex.dispose(); beamTexOff.dispose()
      // WebGL 컨텍스트는 명시적으로 놓는다. 도면을 여러 번 갈아 끼우면 브라우저가
      // 컨텍스트 상한(보통 16개)에 걸려 가장 오래된 것부터 죽인다.
      //
      // 🔴 forceContextLoss() 를 부른 캔버스는 **다시 살아나지 않는다**.
      //    WEBGL_lose_context 로 잃은 컨텍스트는 restoreContext() 전까지 죽은 채고, 같은
      //    <canvas> 에 getContext() 를 다시 불러도 브라우저는 그 죽은 컨텍스트를 그대로
      //    돌려준다(캔버스 하나당 컨텍스트는 하나다 — 실측 확인).
      //    매핑이 끝나 도면이 교체되면 이 이펙트가 다시 도는데, 캔버스가 같은 것이면
      //    새 WebGLRenderer 가 **생성 도중 예외를 던진다** — 죽은 컨텍스트에서는
      //    getShaderPrecisionFormat() 이 null 을 돌려주고, three 의 WebGLCapabilities 가
      //    그것의 .precision 을 읽다 TypeError 가 난다.
      //    이 앱에는 에러 경계가 없어서 그 예외는 React 루트 전체를 걷어낸다 —
      //    그래서 화면이 통째로 하얘지고, 새로고침(=새 캔버스)해야 돌아왔다.
      //    그래서 위 <canvas> 에 key={sceneSeq} 를 걸어 씬마다 캔버스를 새로 만든다 —
      //    여기서 죽이는 것은 화면에서 이미 떨어져 나간 옛 캔버스다.
      renderer.dispose()
      renderer.forceContextLoss()
    }
  }, [grid])

  // 상단 +/− 버튼(MapPanel 의 zoomFactor)을 카메라 거리로 옮긴다.
  useEffect(() => {
    zoomFactorRef.current = zoomFactor
    apiRef.current?.setZoom(zoomFactor)
  }, [zoomFactor])

  const toggleFollow = useCallback(() => {
    setFollow((on) => {
      // 끄는 길: 개요 시점으로 되돌린다. 추종 중 카메라를 로봇에 묶어 뒀으므로
      // 그냥 끄면 로봇 뒤통수를 본 채로 멈춘다.
      if (on) apiRef.current?.reset()
      return !on
    })
  }, [])

  // 마우스에만 길을 두지 않는다 — 방향키로 돌리고 +/− 로 확대한다.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (followRef.current) return   // 추종 중에는 카메라가 자동이다
    const el = canvasRef.current
    if (!el) return
    const key = e.key
    if (key === '+' || key === '=') { apiRef.current?.setZoom(zoomFactorRef.current * 1.3); e.preventDefault(); return }
    if (key === '-') { apiRef.current?.setZoom(zoomFactorRef.current / 1.3); e.preventDefault(); return }
    // OrbitControls 는 포인터만 듣는다. 방향키는 휠·드래그와 같은 이벤트로 흉내 낸다.
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -30], ArrowDown: [0, 30],
    }
    const d = map[key]
    if (!d) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const opt = { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opt, clientX: cx, clientY: cy }))
    el.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: cx + d[0], clientY: cy + d[1] }))
    el.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { ...opt, buttons: 0, clientX: cx + d[0], clientY: cy + d[1] }))
  }

  // 분기 문구는 IsoMapView 와 글자까지 같게 둔다 — 같은 상황에서 다른 말을 하면
  // 조작자가 두 뷰를 다른 것으로 오해한다.
  if (!plan) {
    return <span className="nodata">{connected ? '활성 도면이 없습니다' : '연결 대기'}</span>
  }
  if (!isFloorplan(plan)) {
    return <span className="nodata">정제 도면이 아니라 입체로 보여줄 수 없습니다 — 2D 로 보세요</span>
  }
  if (error) return <span className="nodata">{error}</span>
  if (busy && !grid) return <span className="nodata">도면을 세우는 중…</span>
  if (!grid) return <span className="nodata">도면을 세우지 못했습니다</span>
  if (grid.wallRatio <= 0) return <span className="nodata">도면에서 벽을 찾지 못했습니다</span>

  return (
    <div
      ref={hostRef}
      className="three-stage"
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="img"
      aria-label="순찰 구역 3D 지도 — 드래그로 회전, 휠 또는 +/− 로 확대, 방향키로 회전"
    >
      {/* 🔴 key 는 씬 일련번호다 — 지도가 바뀔 때마다 캔버스 DOM 을 새로 만들기 위한 것이다.
          같은 캔버스를 재사용하면 매핑 완료 후 흰 화면이 된다(아래 씬 이펙트의 정리 주석 참조). */}
      <canvas key={sceneSeq} ref={canvasRef} className="three-canvas" />

      {/* 확정 점검 지점(S15P11E101-787). 운영 탭에서 승인한 AprilTag 지점을 3D 씬 위에
          띄운다 — 2D 운영 지도의 마름모 태그와 같은 자리를 짚어 준다. 번호는 순찰이
          도는 차례다. enabled=false(순찰 제외) 지점은 흐리게 둔다 — 지우면 왜 안 도는지
          알 수 없다. 3D 오브젝트가 아니라 HTML 이라 어느 각도에서도 번호가 정면이다. */}
      {pins.map((p) => (
        <div
          key={p.id}
          ref={(el) => { if (el) pinEls.current.set(p.id, el); else pinEls.current.delete(p.id) }}
          className={`three-insp${p.off ? ' off' : ''}`}
          title={p.title}
        >
          <b>{p.seq}</b>
        </div>
      ))}

      {/* 화재/과열 경보 마커 (S15P11E101-883) — 위치 핀 아이콘, 화재=빨강 · 과열=이벤트
          로그 과열색. 점검 핀과 같은 HTML 오버레이라 어느 각도에서도 정면으로 읽힌다.
          누르면 아래 말풍선이 열린다(다시 누르면 닫힘). */}
      {alertPins.map((p) => (
        <button
          key={p.id}
          type="button"
          ref={(el) => { if (el) alertEls.current.set(p.id, el); else alertEls.current.delete(p.id) }}
          className={`three-alert ${p.kind}`}
          title={`${p.title} ${p.time} — 눌러서 상세`}
          aria-expanded={alertSel === p.id}
          onClick={() => setAlertSel((cur) => (cur === p.id ? null : p.id))}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            {/* 확정 마커 아이콘 — 위치 핀(물방울 + 중심점) 아래 바닥 타원 */}
            <path fill="currentColor" d="M12 1.8c-3.5 0-6.3 2.7-6.3 6.1 0 4.4 6.3 10.4 6.3 10.4s6.3-6 6.3-10.4c0-3.4-2.8-6.1-6.3-6.1Z" />
            <circle cx="12" cy="7.8" r="2.1" fill="#fff" />
            <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
              d="M7.4 16.4c-2.3.6-3.8 1.6-3.8 2.7 0 1.8 3.8 3.2 8.4 3.2s8.4-1.4 8.4-3.2c0-1.1-1.5-2.1-3.8-2.7" />
          </svg>
        </button>
      ))}

      {/* 경보 말풍선 — 발생 시간과 전면 카메라 실시간 영상. 위치는 렌더 루프가
          마커와 같은 투영으로 매 프레임 갱신한다. */}
      {alertSel != null && (() => {
        const p = alertPins.find((v) => v.id === alertSel)
        if (!p) return null
        return (
          <div ref={popEl} className="three-alert-pop" role="dialog" aria-label={`${p.title} 상세`}>
            <div className="three-alert-pop__head">
              <b className={p.kind}>{p.title}</b>
              <span className="mono">{p.time}</span>
              <button type="button" className="three-alert-pop__x" onClick={() => setAlertSel(null)} aria-label="말풍선 닫기">×</button>
            </div>
            {p.sub && <div className="three-alert-pop__sub">{p.sub}</div>}
            <AlertLiveVideo />
          </div>
        )
      })()}

      {/* 위치를 믿을 수 없으면 왜 로봇이 없는지 말한다(S15P11E101-773).
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
        title={follow ? '네비게이션 모드 — 눌러서 개요 시점으로' : '로봇을 따라가는 시점(자동차 내비처럼)'}
      >
        {/* 버튼명 '로봇 추종/추종 중' → '네비게이션 모드'(S15P11E101-889).
            켜짐 여부는 .on 클래스(aria-pressed)가 시각으로 말한다 — 문구는 하나로 둔다. */}
        네비게이션 모드
      </button>
    </div>
  )
}
