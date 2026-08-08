// 배경 순찰 씬 — 로그아웃 상태(웰컴 · 로그인)의 **공통 배경**이다.
//
// 🔴 왜 WelcomeScreen 밖으로 나왔나 (S15P11E101-808)
// 전에는 이 씬이 WelcomeScreen 안에 있었다. 그래서 로그인으로 넘어가는 순간
// WelcomeScreen 이 언마운트되며 씬도 같이 사라졌고, 돌아오면 로봇이 경로 시작점에서
// 처음부터 다시 돌았다. 전환 연출의 요구("배경 순찰 씬은 계속 살아 있다 — 로봇이
// 멈추지 않는다")는 컴포넌트 배치 문제이지 애니메이션 문제가 아니다.
// → 웰컴과 로그인의 **공통 부모**(AuthFlow)로 끌어올려, 두 상태 어디서도
//   언마운트되지 않게 했다. rAF 루프도 clock 도 그대로 이어진다.
//
// 씬의 형태는 레퍼런스(Navexa Warehouses)의 "라우팅 씬"에서 가져왔다:
//   통로망(옅게, 배경) 위로 직교(90°) 순찰 코스(굵게)가 지나가고, 코스 위를 로봇이
//   다니며 상태 카드를 달고 다닌다. 이상 구간은 붉은 경로로 갈라진다.
//
// 색·타이포·radius·그림자는 한 값도 여기 적지 않는다. styles/tokens.css 의 --bb-* 를
// styles/app.css 의 .welcome-* 규칙이 참조한다.
//
// 모션: 진입 stagger·경로 draw-in·라이다 스윕은 전부 CSS 다. JS 가 하는 일은 두 가지 —
// ① 순찰 로봇(과 그 상태 카드)을 경로 위에서 움직이는 것 ② dwell 중인 배전반에만
// 온도 배지를 켜는 것(둘 다 transform/classList 만 건드리고 리렌더는 없다).

import { useEffect, useRef } from 'react'
import { ROBOT_ID } from '../../live/config.ts'

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 🔶 [더미 데이터 — 실측/실데이터 아님]                                      ║
// ║ 🔴 실데이터 연동 시 이 블록을 통째로 지운다.                                ║
// ║ 🔴 이 화면 밖 인용 금지 · docs/실측_데이터.md 와 아무 관계가 없다.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// 로봇 상태 카드는 더미다. 하단 통계 카드(WelcomeScreen)와 모순되지 않게 맞춘다 —
// 통계가 "누적 순찰 시간"이니 상태는 순찰/점검/복귀 사이만 오간다.
// "충전 중"은 쓰지 않는다(그러면 순찰 중이 아니게 된다).
const BATTERY_PCT = 68
const BATTERY_LOW_PCT = 30            // 이 아래면 주의색(과열 계열)으로 넘어간다

// 붉은 경로와 경보 배지도 더미다 — 실제 감지 이벤트가 아니라 "이상 구간이 이렇게 보인다"는 예시.
// 배전반 온도도 전부 더미다 — 열화상으로 실제로 잰 값이 아니다.
const CABINET_TEMPS: readonly { c: number, judge: 'ok' | 'warn' }[] = [
  { c: 42.6, judge: 'ok' },    // 배전반 A
  { c: 58.3, judge: 'warn' },  // 배전반 B — 주의 판정이 하나는 있어야 색 대비가 읽힌다
  { c: 39.1, judge: 'ok' },    // 배전반 C
]
// ── 더미 블록 끝 ────────────────────────────────────────────────────────────

// 씬 SVG 의 좌표계. preserveAspectRatio="none" 이라 viewBox 가 박스에 선형으로 늘어난다 —
// 그래서 경로 위 점(viewBox 단위)을 px 로 바꾸는 건 단순 비례식이다.
const VB_W = 1440
const VB_H = 900

// ── 하단 2연 카드 금지 구역 ──────────────────────────────────────────────────
// 카드가 넓어진 만큼(2연) 좌우로 회피 차선을 낼 여유가 없다 — 대신 세로로 통째로 비운다.
// 씬의 모든 요소는 viewBox y ≤ 500(경로) / ≤ 568(설비·배전반) 안에 둔다.
// 추가 금지 구역: x < 740 은 히어로 패널 자리(기존과 동일).

// ── 통로망 vs 순찰 코스 ─────────────────────────────────────────────────────
// 범례가 없으므로 "무엇이 오늘 가는 길인가"를 **형태만으로** 갈라야 한다.
// 통로망(옅게, 배경 · 굵기 1.5 · opacity .82)이 먼저 뜨고, 그 위로 순찰 코스(굵게 · 3.8)가
// 그려진다 — 굵기 대비 2.5배 + 등장 순서(통로 0.1s 페이드 → 코스 0.35s draw-in)로 구분한다.
// 행은 180 / 320 / 370 / 500, 열은 800 / 940 / 1080 / 1220 / 1350.
const CORRIDORS =
  'M800 180 H1350 ' +      // 북쪽 간선
  'M940 250 H1220 ' +      // 짧은 연결 통로 — 순찰 코스가 안 쓰는 길
  'M1080 320 H1350 ' +
  'M800 370 H1350 ' +      // 가운데 간선
  'M800 500 H1350 ' +      // 남쪽 간선 (이 아래는 하단 2연 카드 금지 구역 — 아무것도 두지 않는다)
  'M800 180 V500 ' +       // 서쪽 간선
  'M940 180 V370 ' +
  'M1080 320 V500 ' +
  'M1220 180 V500 ' +
  'M1350 180 V500'         // 동쪽 간선

// 순찰 코스 — 통로망 위의 닫힌 순환로. 한 방향으로만 돈다.
// 🔴 모든 꼭짓점이 **진짜 90° 코너**여야 한다 — 일직선 위의 꼭짓점을 넣으면 필렛 원호가
// 퇴화해 경로에 혹이 생기고 로봇 방향도 틀어진다(buildRoute 가 그런 점을 걸러내지만,
// 애초에 넣지 않는 것이 맞다).
const PATROL: readonly (readonly [number, number])[] = [
  [800, 180], [1220, 180],   // 북쪽 간선을 동쪽으로 길게
  [1220, 320],               // 남하 (← 배전반 A 점검, 꼭짓점 2)
  [1350, 320],               // 동쪽 간선으로
  [1350, 500],               // 남하 (← 배전반 B 점검, 꼭짓점 4)
  [1080, 500],               // 남쪽 간선을 서쪽으로
  [1080, 370],               // 북상 (← 배전반 C 점검, 꼭짓점 6)
  [800, 370],                // 가운데 간선으로 서쪽 끝까지 (복귀, 닫힘: → [800,180])
]
const CORNER_R = 22          // 모서리 필렛 반지름. 가장 짧은 구간(130)의 절반보다 작아야 한다.

// 이상 구간 — 경보 경로. 남쪽 간선에서 갈라져 경보 설비로 내려간다.
const ALARM_D = 'M940 500 L940 542'

// 설비 블록. 통로망의 빈 칸 중앙에 놓아 통로를 안 막는다. 배전반(세로 캐비닛) 및 그 아래
// 온도 배지와도 겹치지 않는 셀만 남는다.
const EQUIPMENT: readonly { x: number, y: number, tone?: 'ok' | 'alarm' }[] = [
  { x: 870, y: 285 },              // 셀 800~940 / 180~370
  { x: 1300, y: 245, tone: 'ok' }, // 셀 1220~1350 / 180~320
  { x: 1000, y: 440 },             // 셀 940~1080 / 370~500
  { x: 870, y: 435 },              // 셀 800~940 / 370~500
  { x: 940, y: 568, tone: 'alarm' },
]

// 배전반 — 통로 벽면에 붙은 세로 캐비닛(일반 설비는 가로 슬래브라 형태로 구분). DWELL_AT_VERTEX 와 1:1
// (0→꼭짓점2, 1→4, 2→6). 🔴 셋 다 정지 지점의 **아래쪽** — 상태 카드가 로봇 위를 늘 덮으므로
// 위에 두면 정지할 때마다 카드에 가려 사라진다. 동시에 셋 다 vb y ≤ 568(하단 2연 카드 금지 구역).
// id 는 지어낸 형식이 아니다 — 실제 GET /api/equipments 응답의 equipmentId 형식
// (`panel_01`, `panel_02` …, docs/backend_api_specification.md §1.3)을 그대로 따른다.
// 로봇이 `orinka_01` 로 식별되듯 배전반도 이 화면에서부터 식별자를 달고 나온다.
const CABINETS: readonly { x: number, y: number, name: string, id: string }[] = [
  { x: 1272, y: 412, name: '배전반 A', id: 'panel_01' },   // 꼭짓점 2 (1220,320) 아래
  { x: 1302, y: 568, name: '배전반 B', id: 'panel_02' },   // 꼭짓점 4 (1350,500) 아래
  { x: 1138, y: 435, name: '배전반 C', id: 'panel_03' },   // 꼭짓점 6 (1080,370) 아래
]

// 스윕이 끝나는 꼭짓점(2·4·6)에 도착하면 잠깐 멈춘다 — 각 지점의 배전반을 "점검"하는 동안이다.
const DWELL_AT_VERTEX = [2, 4, 6]
const DWELL_MS = 1800
// SPEED_U_PER_S 는 로봇의 체감 속도 — 경로가 짧아진 만큼 한 바퀴 시간도 줄었다(≈ 81초).
const SPEED_U_PER_S = 22
const RETURN_FROM_SEG = 12    // 꼭짓점 6 을 떠나는 순간부터 가운데 간선을 타고 복귀
const TRAIL = 0.09            // 로봇 뒤에 남는 지나온 자취의 길이(경로 전체 대비)

type Pt = { x: number, y: number }
type Seg =
  | { kind: 'line', a: Pt, b: Pt, len: number }
  | { kind: 'arc', c: Pt, a0: number, sign: number, len: number }

/** 직교 폴리라인을 "직선 + 90° 원호"로 필렛한다.
 *  그린 경로(d 문자열)와 로봇이 따라가는 기하가 **같은 데이터에서 나오므로** 모서리에서
 *  로봇이 선 밖으로 새지 않는다. 원호 길이가 정확히 πr/2 라 길이 계산도 해석적으로 끝난다. */
function buildRoute() {
  // 🔴 일직선 위의 꼭짓점을 먼저 걸러낸다. 꺾이지 않는 점에 필렛을 씌우면 원호가 퇴화해
  // 경로에 반원 혹이 생기고(눈에 띈다) 그 구간에서 로봇이 엉뚱한 방향을 본다.
  const raw: Pt[] = PATROL.map(([x, y]) => ({ x, y }))
  const V: Pt[] = raw.filter((v, i) => {
    const p = raw[(i - 1 + raw.length) % raw.length], q = raw[(i + 1) % raw.length]
    return Math.abs((v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x)) > 1e-6
  })
  const n = V.length
  const dir = V.map((v, i) => {
    const w = V[(i + 1) % n]
    const dx = w.x - v.x, dy = w.y - v.y
    const L = Math.hypot(dx, dy)
    return { x: dx / L, y: dy / L }
  })

  const A: Pt[] = [], B: Pt[] = [], sweep: number[] = []
  const segs: Seg[] = []
  const arcMeta: { c: Pt, a0: number, sign: number }[] = []

  for (let i = 0; i < n; i++) {
    const di = dir[(i - 1 + n) % n]          // 들어오는 방향
    const dof = dir[i]                        // 나가는 방향
    const a = { x: V[i].x - di.x * CORNER_R, y: V[i].y - di.y * CORNER_R }
    const b = { x: V[i].x + dof.x * CORNER_R, y: V[i].y + dof.y * CORNER_R }
    // 90° 코너의 원 중심 — A 에서 나가는 방향으로 r 만큼. |C-A| = |C-B| = r 이 성립한다.
    const c = { x: a.x + dof.x * CORNER_R, y: a.y + dof.y * CORNER_R }
    const cross = di.x * dof.y - di.y * dof.x
    A.push(a); B.push(b); sweep.push(cross > 0 ? 1 : 0)
    arcMeta.push({ c, a0: Math.atan2(a.y - c.y, a.x - c.x), sign: cross > 0 ? 1 : -1 })
  }

  let d = `M${A[0].x.toFixed(2)} ${A[0].y.toFixed(2)}`
  for (let i = 0; i < n; i++) {
    const nx = A[(i + 1) % n]
    segs.push({ kind: 'arc', ...arcMeta[i], len: (Math.PI / 2) * CORNER_R })
    segs.push({ kind: 'line', a: B[i], b: nx, len: Math.hypot(nx.x - B[i].x, nx.y - B[i].y) })
    d += ` A${CORNER_R} ${CORNER_R} 0 0 ${sweep[i]} ${B[i].x.toFixed(2)} ${B[i].y.toFixed(2)}`
    d += ` L${nx.x.toFixed(2)} ${nx.y.toFixed(2)}`
  }
  return { segs, d: d + ' Z', nodes: V }
}

const ROUTE = buildRoute()

// 코너에서 감속·가속하되 너무 튀지 않게 — smoothstep 을 절반만 섞는다.
// (온전한 smoothstep 은 구간 중앙 속도가 1.5배까지 올라 급해 보인다.)
const ease = (t: number) => 0.55 * (t * t * (3 - 2 * t)) + 0.45 * t

type Phase = { t0: number, t1: number, seg: number, dwell: boolean, s0: number, s1: number }

/** "이동 → (웨이포인트면) 정지" 타임라인. s0/s1 은 경로 전체 길이 대비 누적 진행률 — 자취용. */
function buildTimeline() {
  // 꼭짓점 k 에 도착하는 순간 = 그 앞 직선 세그먼트(2k-1)의 끝
  const dwellAfterSeg = new Set(DWELL_AT_VERTEX.map((k) => 2 * k - 1))
  const total = ROUTE.segs.reduce((s, g) => s + g.len, 0)
  const phases: Phase[] = []
  let t = 0, acc = 0
  ROUTE.segs.forEach((g, i) => {
    const dur = (g.len / SPEED_U_PER_S) * 1000
    phases.push({ t0: t, t1: t + dur, seg: i, dwell: false, s0: acc / total, s1: (acc + g.len) / total })
    t += dur; acc += g.len
    if (dwellAfterSeg.has(i)) {
      phases.push({ t0: t, t1: t + DWELL_MS, seg: i, dwell: true, s0: acc / total, s1: acc / total })
      t += DWELL_MS
    }
  })
  return { phases, cycleMs: t }
}

// dwell 세그먼트 인덱스 → 배전반 인덱스 역매핑(온도 배지를 그 배전반에만 켜기 위해).
const SEG_TO_CAB = new Map(DWELL_AT_VERTEX.map((k, i) => [2 * k - 1, i]))

/** 세그먼트 위 위치와 진행 방향(viewBox 단위). */
function sample(g: Seg, e: number) {
  if (g.kind === 'line') {
    return {
      x: g.a.x + (g.b.x - g.a.x) * e, y: g.a.y + (g.b.y - g.a.y) * e,
      tx: g.b.x - g.a.x, ty: g.b.y - g.a.y,
    }
  }
  const ang = g.a0 + g.sign * (Math.PI / 2) * e
  return {
    x: g.c.x + CORNER_R * Math.cos(ang), y: g.c.y + CORNER_R * Math.sin(ang),
    tx: -Math.sin(ang) * g.sign, ty: Math.cos(ang) * g.sign,
  }
}

/** 순찰 로봇과 그 상태 카드를 경로 위에서 움직이고, dwell 중인 배전반에만 온도 배지를 켠다.
 *  - 매 프레임 건드리는 건 transform 세 개(로봇·방향 화살표·카드)와 classList 뿐 —
 *    리렌더도, 레이아웃도 없다.
 *  - 자취(stroke-dashoffset)는 값이 눈에 띄게 변할 때만 갱신해 리페인트를 줄인다.
 *  - 탭이 가려지면 진행을 멈추고, 돌아오면 시계를 다시 잡아 튀지 않게 한다.
 *  - prefers-reduced-motion 이면 루프를 시작하지 않고 경로 시작점에 세워 둔다.
 *  🔴 이 훅은 로그인 전환 중에도 계속 살아 있어야 한다 — 그래서 컴포넌트가
 *     웰컴/로그인 어느 상태에서도 언마운트되지 않는 자리(AuthFlow)에 있다. */
function usePatrolMotion(refs: {
  scene: React.RefObject<HTMLDivElement>
  robot: React.RefObject<HTMLDivElement>
  dir: React.RefObject<HTMLDivElement>
  card: React.RefObject<HTMLDivElement>
  status: React.RefObject<HTMLSpanElement>
  trail: React.RefObject<SVGPathElement>
  cabs: React.RefObject<(HTMLDivElement | null)[]>
  badges: React.RefObject<(HTMLDivElement | null)[]>
}) {
  useEffect(() => {
    const scene = refs.scene.current, robot = refs.robot.current, dirEl = refs.dir.current
    const card = refs.card.current, status = refs.status.current, trail = refs.trail.current
    if (!scene || !robot || !dirEl || !card || !status || !trail) return

    const { phases, cycleMs } = buildTimeline()
    let w = scene.clientWidth, h = scene.clientHeight
    let cardW = card.offsetWidth, cardH = card.offsetHeight
    let clock = 0
    let lastLabel = ''
    let lastTrail = -1
    let lastDwellSeg = -2

    const place = () => {
      const p = phases.find((q) => clock < q.t1) ?? phases[phases.length - 1]
      const g = ROUTE.segs[p.seg]
      const e = p.dwell ? 1 : ease((clock - p.t0) / (p.t1 - p.t0))
      const pt = sample(g, e)

      const rx = (pt.x / VB_W) * w
      const ry = (pt.y / VB_H) * h
      // 씬은 가로세로 배율이 달라(preserveAspectRatio=none) 각도를 화면 px 로 재야 한다.
      const deg = Math.atan2((pt.ty / VB_H) * h, (pt.tx / VB_W) * w) * 180 / Math.PI

      robot.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`
      dirEl.style.transform = `rotate(${deg}deg)`

      // 🔴 카드는 항상 로봇 "위"에 고정한다(사용자 결정 2026-08-07) — 좌우로는 절대 넘기지
      // 않는다. 가로는 로봇 중심 정렬 + 씬 좌우 경계 클램프. 세로만 예외: 위에 자리가 없을
      // 때(씬 상단을 지날 때)만 아래로 내린다. 배전반을 정지 지점 아래에 두는 배치와 짝을
      // 이뤄야 상태 카드가 온도 배지를 가리지 않는다.
      const cx = Math.max(18, Math.min(rx - cardW / 2, w - cardW - 18))
      let cy = ry - cardH - 26
      if (cy < 18) cy = Math.min(ry + 26, h - cardH - 18)
      card.style.transform = `translate3d(${cx}px, ${cy}px, 0)`

      const label = p.dwell ? '점검 중' : p.seg >= RETURN_FROM_SEG ? '복귀 중' : '순찰 중'
      if (label !== lastLabel) { status.textContent = label; lastLabel = label }

      // 정지 중인 배전반에만 온도 배지를 켠다 — dwell 세그먼트를 배전반 인덱스로 역매핑.
      const dSeg = p.dwell ? p.seg : -1
      if (dSeg !== lastDwellSeg) {
        const on = SEG_TO_CAB.has(dSeg) ? SEG_TO_CAB.get(dSeg)! : -1
        refs.badges.current?.forEach((el, i) => el?.classList.toggle('is-on', i === on))
        refs.cabs.current?.forEach((el, i) => el?.classList.toggle('is-on', i === on))
        lastDwellSeg = dSeg
      }

      // 지나온 자취 — 로봇 뒤로 TRAIL 만큼만 진하게. 닫힌 루프라 "다 차고 리셋"이 없다.
      const s = p.dwell ? p.s1 : p.s0 + (p.s1 - p.s0) * e
      if (Math.abs(s - lastTrail) > 0.0015) {
        trail.style.strokeDashoffset = String(-(s - TRAIL))
        lastTrail = s
      }
    }

    const ro = new ResizeObserver(() => {
      w = scene.clientWidth; h = scene.clientHeight
      cardW = card.offsetWidth; cardH = card.offsetHeight
      place()
    })
    ro.observe(scene)
    place()

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return () => ro.disconnect()
    }

    let raf = 0
    let last = performance.now()
    const onVisible = () => { if (!document.hidden) last = performance.now() }
    document.addEventListener('visibilitychange', onVisible)

    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (!document.hidden) { clock = (clock + dt) % cycleMs; place() }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisible)
      ro.disconnect()
    }
  }, [refs])
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`

export default function PatrolScene() {
  const scene = useRef<HTMLDivElement>(null)
  const robot = useRef<HTMLDivElement>(null)
  const dir = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const trail = useRef<SVGPathElement>(null)
  const cabRefs = useRef<(HTMLDivElement | null)[]>([])
  const badgeRefs = useRef<(HTMLDivElement | null)[]>([])
  usePatrolMotion({ scene, robot, dir, card, status, trail, cabs: cabRefs, badges: badgeRefs })

  const batteryLow = BATTERY_PCT < BATTERY_LOW_PCT

  return (
    // 씬: 화면 끝까지 깔린다. 순수 장식이라 스크린리더에서 감춘다.
    <div className="welcome-scene" aria-hidden="true" ref={scene}>
      <div className="welcome-scene__grid" />

      <svg className="welcome-scene__path" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none">
        {/* 통로망 — 배경. 형태만으로 코스와 갈리도록 굵기 1.5 + opacity .82. */}
        <path className="p-corridor" d={CORRIDORS} fill="none" stroke="#D2D6E2" strokeWidth="1.5" strokeLinecap="round" />
        {/* 오늘 도는 순찰 코스. pathLength="1" 이라 CSS 가 실제 길이를 몰라도 1→0 으로 그려 낸다. */}
        <path className="p-route" pathLength={1} d={ROUTE.d} fill="none" stroke="#B9D3C4" strokeWidth="3.8" strokeLinejoin="round" />
        {/* 로봇이 지나온 자취 — dashoffset 만 움직여 로봇 뒤를 따라온다 */}
        <path
          ref={trail} className="p-trail" pathLength={1} d={ROUTE.d}
          fill="none" stroke="#6FA487" strokeWidth="2.5"
          strokeDasharray={`${TRAIL} ${1 - TRAIL}`} strokeDashoffset={0}
        />
        {/* 이상 구간 — 경보 경로 */}
        <path className="p-alarm" d={ALARM_D} fill="none" stroke="#D08C84" strokeWidth="2" />
        {/* 웨이포인트 노드 */}
        {ROUTE.nodes.map((n) => (
          <circle key={`${n.x}-${n.y}`} className="p-node" cx={n.x} cy={n.y} r="4.5" fill="#fff" stroke="#C3C9D6" strokeWidth="1.5" />
        ))}
        {/* 경보 경로 끝 — 위 ALARM_D 의 끝점과 같은 자리여야 한다 */}
        <circle className="p-node" cx="940" cy="542" r="4" fill="#D08C84" />
      </svg>

      {/* 설비 블록 — 경로가 이 사이를 지난다 */}
      {/* 진입 stagger 지연은 인라인으로 준다 — CSS :nth-of-type 은 형제 중 div 를 세기 때문에
          씬 안의 다른 div(격자·로봇·카드)까지 함께 세어 엉뚱한 요소를 짚는다. */}
      {EQUIPMENT.map((e, i) => (
        <div
          key={`${e.x}-${e.y}`}
          className={`welcome-eq${e.tone ? ` welcome-eq--${e.tone}` : ''}`}
          style={{ left: pct(e.x, VB_W), top: pct(e.y, VB_H), animationDelay: `${0.30 + i * 0.08}s` }}
        />
      ))}

      {/* 배전반 — 세로 캐비닛. 이미 과열(judge:'warn')인 배전반은 dwell 여부와 무관하게
          항상 warn 톤으로 보인다 — "붉은(경고) 객체 = 이미 온도가 높은 배전반" [사용자 지침
          2026-08-08]. 🔴 화재 danger 톤이 아니라 warn 톤을 쓴다 — 이 저장소의 상태색 규칙상
          danger 는 화재 전용이고 과열은 warn 이다(§B 디자인 시스템 규칙). */}
      {CABINETS.map((c, i) => {
        const warn = CABINET_TEMPS[i].judge === 'warn'
        return (
          <div
            key={c.name}
            className={`welcome-cab${warn ? ' welcome-cab--warn' : ''}`}
            ref={(el) => { cabRefs.current[i] = el }}
            title={`${c.name} · ${c.id}`}
            style={{ left: pct(c.x, VB_W), top: pct(c.y, VB_H), animationDelay: `${1.0 + i * 0.1}s` }}
          />
        )
      })}
      {CABINETS.map((c, i) => {
        const t = CABINET_TEMPS[i]
        return (
          <div
            key={`${c.name}-badge`}
            className="welcome-badge"
            ref={(el) => { badgeRefs.current[i] = el }}
            style={{ left: pct(c.x, VB_W), top: pct(c.y, VB_H) }}
          >
            <div className="welcome-badge__in">
              <span className="welcome-badge__id mono">{c.id}</span>
              <span className="welcome-badge__t mono">{t.c.toFixed(1)}°C</span>
              <span className={`welcome-badge__j welcome-badge__j--${t.judge}`}>
                {t.judge === 'ok' ? '정상' : '주의'}
              </span>
            </div>
          </div>
        )
      })}

      {/* 경보 배지 */}
      <div className="welcome-alarm" style={{ left: pct(892, VB_W), top: pct(536, VB_H) }}>
        <svg viewBox="0 0 12 11" aria-hidden="true"><path d="M6 0.6 11.4 10.4H0.6z" fill="currentColor" /></svg>
      </div>

      {/* 순찰 로봇 — 위치·방향은 usePatrolMotion 이 transform 으로만 갱신한다 */}
      <div className="welcome-robot" ref={robot}>
        <div className="welcome-robot__sweep" />
        <div className="welcome-robot__card">
          <div className="welcome-robot__dir" ref={dir} />
        </div>
      </div>

      {/* 로봇을 따라다니는 상태 카드 (값은 위 [더미 데이터] 블록) */}
      <div className="welcome-robotcard" ref={card}>
        <div className="welcome-robotcard__id mono">{ROBOT_ID}</div>
        <div className="welcome-robotcard__bat">
          <span className="lbl">배터리</span>
          <span className="mono val">{BATTERY_PCT}%</span>
          <span className={`gauge${batteryLow ? ' low' : ''}`}><i style={{ width: `${BATTERY_PCT}%` }} /></span>
        </div>
        <div className="welcome-robotcard__st"><i /><span ref={status}>순찰 중</span></div>
      </div>

      {/* 씬 범례 — 배전반 색의 의미(정상/과열). 지도 화면 범례(#pgMap .maplegend)와
          같은 문법 재사용: 씬 위의 작은 반투명 알약, 지도 축척처럼 우측 하단.
          [사용자 지침 2026-08-08] */}
      <div className="welcome-scene-legend">
        <span className="welcome-scene-legend__row">
          <i className="welcome-scene-legend__mark welcome-scene-legend__mark--ok" />정상
        </span>
        <span className="welcome-scene-legend__row">
          <i className="welcome-scene-legend__mark welcome-scene-legend__mark--warn" />과열 배전반
        </span>
      </div>
    </div>
  )
}
