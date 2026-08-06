// 진입(랜딩) 화면 — 로그인 전에 표시. "접속" → 로그인 화면으로 진입.
//
// v3 디자인 시스템 "플로팅 씬" 배치(시안 A). 이전 다크 하드코딩판을 대체한다.
// 화면 끝까지 밝은 씬을 깔고, 정보는 그 위에 뜬다 — 좌우로 칸을 나누지 않는다.
//
// 씬의 형태는 레퍼런스(Navexa Warehouses)의 "라우팅 씬"에서 가져왔다:
//   직교(90°) 경로가 모서리마다 둥글게 꺾이며 설비 사이를 지나고, 경로 위를 로봇이
//   다니며 상태 카드를 달고 다닌다. 이상 구간은 붉은 경로로 갈라진다.
// 레퍼런스의 좌측 로봇 목록 패널과 하단 대형 차트 카드는 가져오지 않는다 — 우리 화면의
// 좌측은 히어로(브랜드·CTA)이고, 하단은 잘려 걸친 통계 카드 한 장이다.
//
// 색·타이포·radius·그림자는 한 값도 여기 적지 않는다. styles/tokens.css 의 --bb-* 를
// styles/app.css 의 .welcome-* 규칙이 참조한다.
//
// 모션: 진입 stagger·경로 draw-in·라이다 스윕은 전부 CSS 다. JS 가 하는 일은 하나뿐 —
// 순찰 로봇(과 그 상태 카드)을 경로 위에서 움직이는 것.

import { useEffect, useRef } from 'react'
import { ROBOT_ID } from '../../live/config.ts'

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 🔶 [더미 데이터 — 실측/실데이터 아님]                                      ║
// ║ 🔴 실데이터 연동 시 이 블록을 통째로 지운다.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// 로그인 전 랜딩이라 붙일 실데이터가 없다. 값을 비워 두면 "불러오기 실패"처럼 읽혀서
// 사용자 승인(2026-08-06) 아래 장식용 더미를 넣었다.
// docs/실측_데이터.md 와 아무 관계가 없다 — 이 화면 밖으로 인용하지 말 것.
//
// 값의 근거: 우리 제품이 운용하는 순찰 로봇은 **1대**다(live/config.ts ROBOT_ID).
// 대수가 많은 물류 로봇 레퍼런스의 숫자를 그대로 베끼면 거짓말이 된다.
// 아래는 1대가 충전을 껴 가며 하루 5~8.5시간 순찰하는, 배치 20일차 기준 일별 순찰 시간(h).
const PATROL_HOURS_BY_DAY = [
  5.2, 6.1, 4.8, 6.9, 5.5, 7.2, 6.4, 5.0, 6.8, 7.6,
  6.0, 5.7, 7.1, 8.2, 6.6, 5.9, 7.4, 8.5, 6.3, 5.3,
]
// 총계는 배열의 합으로 계산한다 — 손으로 적으면 막대 합과 어긋나고, 그 어긋남이 눈에 띈다.
const PATROL_HOURS_TOTAL = PATROL_HOURS_BY_DAY.reduce((a, b) => a + b, 0)   // 128.5 h
// 미니 차트는 "추세의 인상"만 준다 — 축·격자선·범례·툴팁 없음(디자인 규칙 4).
// 컨테이너가 30px 라 4.8~8.5h 가 16~29px 로 들어가는 배율. 마지막 3개(최근 3일)만 강조.
const SPARK_PX_PER_HOUR = 3.4

// 로봇 상태 카드도 더미다. 통계 카드와 모순되지 않게 맞춘다 — 통계가 "누적 순찰 시간"이니
// 상태는 순찰/점검/복귀 사이만 오간다. "충전 중"은 쓰지 않는다(그러면 순찰 중이 아니게 된다).
const BATTERY_PCT = 68
const BATTERY_LOW_PCT = 30            // 이 아래면 주의색(과열 계열)으로 넘어간다
// 붉은 경로와 경보 배지도 더미다 — 실제 감지 이벤트가 아니라 "이상 구간이 이렇게 보인다"는 예시.
// ── 더미 블록 끝 ────────────────────────────────────────────────────────────

// 씬 SVG 의 좌표계. preserveAspectRatio="none" 이라 viewBox 가 박스에 선형으로 늘어난다 —
// 그래서 경로 위 점(viewBox 단위)을 px 로 바꾸는 건 단순 비례식이다.
const VB_W = 1440
const VB_H = 900

// ── 순찰 경로 ───────────────────────────────────────────────────────────────
// 자유곡선 왕복이 아니라 **직교 통로**다. 공장/창고 통로 느낌은 여기서 나온다.
// 구역을 훑는 보스트로페돈(지그재그) 커버리지 + 좌측 복귀 통로로 닫힌 루프를 만든다.
// 한 방향으로만 돌기 때문에 왕복 티가 나지 않는다.
//   좌측 x<740 은 히어로 패널이, 하단 중앙은 통계 카드가 차지하므로 구역을 우측에 잡았다.
// 안쪽은 구역을 훑는 지그재그 스윕, 바깥은 그 구역을 한 바퀴 도는 복귀 통로다.
// 🔴 모든 꼭짓점이 **진짜 90° 코너**여야 한다 — 일직선 위의 꼭짓점(예: 같은 y 에서 좌우로만
// 이어지는 세 점)을 넣으면 필렛 원호가 퇴화해 경로에 혹이 생기고 로봇 방향도 틀어진다.
// (buildRoute 가 그런 점을 걸러내지만, 애초에 넣지 않는 것이 맞다.)
const PATROL: readonly (readonly [number, number])[] = [
  [760, 260], [1290, 260],   // 스윕 1 →
  [1290, 420], [760, 420],   // 스윕 2 ←
  [760, 580], [1290, 580],   // 스윕 3 →
  [1290, 700], [760, 700],   // 스윕 4 ←
  [760, 780], [1350, 780],   // 복귀: 아래 통로 →
  [1350, 200], [760, 200],   // 복귀: 오른쪽 ↑ · 위 통로 ← (닫힘: ↓ [760,260])
]
const CORNER_R = 22          // 모서리 필렛 반지름. 가장 짧은 구간(60)의 절반보다 작아야 한다.

// 이상 구간 — 경보 경로. 아래 통로에서 갈라져 경보 설비로 내려간다.
const ALARM_D = 'M1100 780 L1100 828'

// 설비 블록. 레퍼런스의 태양광 패널·선반을 베끼지 않는다 — 우리는 공장 안전 관제이므로
// 추상 블록으로 절제한다. 경로가 이 사이를 지나가는 것이 "공장을 순찰한다"를 만든다.
const EQUIPMENT: readonly { x: number, y: number, tone?: 'ok' | 'alarm' }[] = [
  { x: 900, y: 340 },
  { x: 1130, y: 340, tone: 'ok' },
  { x: 930, y: 500 },
  { x: 1200, y: 500 },
  { x: 1060, y: 640 },
  { x: 1100, y: 845, tone: 'alarm' },
]

// 스윕이 끝나는 꼭짓점에 도착하면 잠깐 멈춘다. 등속으로 계속 흐르면 기계적으로 보이고,
// 멈췄다 도는 순간에 "순찰"이 읽힌다.
const DWELL_AT_VERTEX = [1, 3, 5, 7]
const DWELL_MS = 1800
const SPEED_U_PER_S = 46      // viewBox 단위/초. 한 바퀴 약 100초 — 시선을 뺏지 않는 속도.
const RETURN_FROM_SEG = 15    // 이 세그먼트부터 복귀 통로 구간(스윕 4 를 마치고 바깥 통로로 나간다)
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

/** 순찰 로봇과 그 상태 카드를 경로 위에서 움직인다.
 *  - 매 프레임 건드리는 건 transform 세 개(로봇·방향 화살표·카드)뿐 — 리렌더도, 레이아웃도 없다.
 *  - 자취(stroke-dashoffset)는 값이 눈에 띄게 변할 때만 갱신해 리페인트를 줄인다.
 *  - 탭이 가려지면 진행을 멈추고, 돌아오면 시계를 다시 잡아 튀지 않게 한다.
 *  - prefers-reduced-motion 이면 루프를 시작하지 않고 경로 시작점에 세워 둔다. */
function usePatrolMotion(refs: {
  scene: React.RefObject<HTMLDivElement>
  robot: React.RefObject<HTMLDivElement>
  dir: React.RefObject<HTMLDivElement>
  card: React.RefObject<HTMLDivElement>
  status: React.RefObject<HTMLSpanElement>
  trail: React.RefObject<SVGPathElement>
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

      // 카드는 로봇 오른쪽에 붙이되, 씬 밖으로 나갈 것 같으면 반대편으로 넘긴다.
      // (우측 스윕에서 자동으로 왼쪽에 붙고, 그 자리는 히어로 패널보다 한참 오른쪽이다.)
      let cx = rx + 32
      if (cx + cardW > w - 18) cx = rx - 32 - cardW
      cx = Math.max(18, Math.min(cx, w - cardW - 18))
      const cy = Math.max(18, Math.min(ry - cardH / 2, h - cardH - 18))
      card.style.transform = `translate3d(${cx}px, ${cy}px, 0)`

      const label = p.dwell ? '점검 중' : p.seg >= RETURN_FROM_SEG ? '복귀 중' : '순찰 중'
      if (label !== lastLabel) { status.textContent = label; lastLabel = label }

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

export default function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  const scene = useRef<HTMLDivElement>(null)
  const robot = useRef<HTMLDivElement>(null)
  const dir = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const trail = useRef<SVGPathElement>(null)
  usePatrolMotion({ scene, robot, dir, card, status, trail })

  const batteryLow = BATTERY_PCT < BATTERY_LOW_PCT

  return (
    <div
      className="welcome-wrap"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
    >
      {/* ── 씬: 화면 끝까지 깔린다. 순수 장식이라 스크린리더에서 감춘다. ── */}
      <div className="welcome-scene" aria-hidden="true" ref={scene}>
        <div className="welcome-scene__grid" />

        <svg className="welcome-scene__path" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none">
          {/* 훑어야 할 전체 통로. pathLength="1" 이라 CSS 가 실제 길이를 몰라도 1→0 으로 그려 낸다. */}
          <path className="p-ok" pathLength={1} d={ROUTE.d} fill="none" stroke="#B9D3C4" strokeWidth="2" />
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
          {/* 경보 경로 끝 — 아래 ALARM_D 의 끝점과 같은 자리여야 한다 */}
          <circle className="p-node" cx="1100" cy="828" r="4" fill="#D08C84" />
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

        {/* 경보 배지 */}
        <div className="welcome-alarm" style={{ left: pct(1030, VB_W), top: pct(812, VB_H) }}>
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
      </div>

      {/* ── 히어로: 밝은 씬 위이므로 유리 패널을 쓴다(어두운 영상 위엔 금지) ── */}
      <section className="welcome-hero">
        <div className="welcome-eyebrow mono">
          <i />SYSTEM ONLINE
          <span className="sep">SSAFY 부울경 1반 · 팀 E101</span>
        </div>

        <h1 className="welcome-brand">
          삐용<span className="dot">.</span><span className="en mono">BBIYONG</span>
        </h1>

        <p className="welcome-tag">공장 무인 안전<br />이상탐지 통합 관제 시스템</p>

        <p className="welcome-desc">
          순찰 로봇 오린카를 웹 콘솔에서 원격으로 운용합니다.<br />
          현장의 이상 징후를 상시 감시하고, 발생 즉시 대응 체계로 연결합니다.
        </p>

        <div className="welcome-cta-row">
          {/* Filled CTA 는 화면당 1개 */}
          <button className="welcome-cta" onClick={onEnter}>관제 시스템 접속</button>
        </div>

        <div className="welcome-foot mono">BBIYONG CONTROL · v1.0 · © 2026 E101</div>
      </section>

      {/* ── 하단 경계에 걸쳐 잘리는 통계 카드 — "더 있다"는 암시 ──
           수치는 위의 [더미 데이터] 블록에서 온다. 장식이라 스크린리더에서 감춘다 —
           읽어 줘 봐야 사실이 아닌 값이다. */}
      <div className="welcome-edge" aria-hidden="true">
        <div className="welcome-edge__t">누적 순찰 시간</div>
        <div className="welcome-edge__v">
          <b className="mono">{PATROL_HOURS_TOTAL.toFixed(1)}</b><span>/ h</span>
        </div>
        <div className="welcome-spark">
          {PATROL_HOURS_BY_DAY.map((h, i) => (
            <i
              key={i}
              style={{
                height: `${(h * SPARK_PX_PER_HOUR).toFixed(1)}px`,
                background: i >= PATROL_HOURS_BY_DAY.length - 3 ? 'var(--bb-ok)' : undefined,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
