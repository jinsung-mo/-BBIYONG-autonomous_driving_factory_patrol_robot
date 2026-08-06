// 진입(랜딩) 화면 — 로그인 전에 표시. "접속" → 로그인 화면으로 진입.
//
// v3 디자인 시스템 "플로팅 씬" 배치(시안 A). 이전 다크 하드코딩판을 대체한다.
// 화면 끝까지 밝은 씬(56px 격자 + 순찰 경로 + 맵 마커)을 깔고, 정보는 그 위에 뜬다.
// 좌우로 칸을 나누지 않는다 — 씬이 바탕이고 히어로·모듈·통계가 그 위의 레이어다.
//
// 색·타이포·radius·그림자는 한 값도 여기 적지 않는다. styles/tokens.css 의 --bb-* 를
// styles/app.css 의 .welcome-* 규칙이 참조한다.
//
// 모션: 진입 stagger·경로 draw-in·라이다 스윕은 전부 CSS 다. JS 가 하는 일은 하나뿐 —
// 순찰 로봇을 SVG 경로 위에서 왕복시키는 것. 로그인 전 화면이라 실데이터는 못 쓴다.

import { useEffect, useRef } from 'react'

const MODULES = [
  '순찰 로봇',
  '열화상 과열 감시',
  '실시간 SLAM 맵핑',
  '웹 기반 관제',
]

// 미니 차트는 "추세의 인상"만 준다 — 축·격자선·범례·툴팁 없음(디자인 규칙 4).
// 마지막 3개만 정상색으로 강조해 최근 구간을 읽게 한다.
const SPARK = [9, 13, 8, 16, 11, 19, 14, 10, 17, 22, 15, 12, 20, 25, 18, 14, 23, 27, 19, 24]

// 씬 SVG 의 좌표계. preserveAspectRatio="none" 이라 viewBox 가 박스에 선형으로 늘어난다 —
// 그래서 경로 위 점(viewBox 단위)을 px 로 바꾸는 건 단순 비례식이다.
const VB_W = 1440
const VB_H = 900
// 한 방향 주행 26초(왕복 52초). 더 빠르면 시선을 뺏어 CTA 를 방해한다.
const LEG_MS = 26000
// 경로 끝까지 가면 로봇이 우측 모듈 카드 위로 올라탄다 — 정보를 가리면 안 되므로 순찰 구간을
// 경로의 앞 72%로 자른다. 끝에서 돌아서는 왕복이라 잘린 게 눈에 띄지 않는다.
const TRAVEL = 0.72

/** 순찰 로봇을 정상 경로 위에서 왕복시킨다.
 *  - 매 프레임 건드리는 건 marker.style.transform 하나뿐 — 리렌더도, 레이아웃도 없다.
 *  - 탭이 가려지면(document.hidden) 진행을 멈추고, 돌아오면 시계를 다시 잡아 튀지 않게 한다.
 *  - prefers-reduced-motion 이면 루프를 아예 시작하지 않고 경로 위 한 지점에 세워 둔다. */
function usePatrolMotion(
  scene: React.RefObject<HTMLDivElement>,
  path: React.RefObject<SVGPathElement>,
  robot: React.RefObject<HTMLDivElement>,
) {
  useEffect(() => {
    const sceneEl = scene.current, pathEl = path.current, robotEl = robot.current
    if (!sceneEl || !pathEl || !robotEl) return

    const total = pathEl.getTotalLength()
    let w = sceneEl.clientWidth, h = sceneEl.clientHeight
    let phase = 0.12   // 0..1 왕복 진행률. reduced-motion 이면 여기 멈춘다.

    const place = () => {
      // 삼각파로 0→1→0 왕복시키고, 코사인으로 양 끝에서 부드럽게 돌아서게 한다.
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2
      const t = 0.5 - Math.cos(Math.PI * tri) / 2
      const p = pathEl.getPointAtLength(t * TRAVEL * total)
      robotEl.style.transform =
        `translate3d(${(p.x / VB_W) * w}px, ${(p.y / VB_H) * h}px, 0) translate(-50%, -50%)`
    }

    const ro = new ResizeObserver(() => {
      w = sceneEl.clientWidth; h = sceneEl.clientHeight; place()
    })
    ro.observe(sceneEl)
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
      if (!document.hidden) {
        phase = (phase + dt / (LEG_MS * 2)) % 1
        place()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisible)
      ro.disconnect()
    }
  }, [scene, path, robot])
}

export default function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const robotRef = useRef<HTMLDivElement>(null)
  usePatrolMotion(sceneRef, pathRef, robotRef)

  return (
    <div
      className="welcome-wrap"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
    >
      {/* ── 씬: 화면 끝까지 깔린다. 순수 장식이라 스크린리더에서 감춘다. ── */}
      <div className="welcome-scene" aria-hidden="true" ref={sceneRef}>
        <div className="welcome-scene__grid" />
        <svg className="welcome-scene__path" viewBox="0 0 1440 900" preserveAspectRatio="none">
          {/* 정상 경로 / 미확인 구간(파선) — 상태색 계열의 옅은 톤.
              pathLength="1" 이라 CSS 가 실제 길이를 몰라도 1→0 으로 그려 낼 수 있다. */}
          <path
            ref={pathRef}
            className="p-ok"
            pathLength={1}
            d="M700 720 L700 560 L1010 560 L1010 300 L1230 300"
            fill="none" stroke="#96C2A9" strokeWidth="2"
          />
          <path className="p-risk" d="M1010 560 L1250 560 L1250 700" fill="none" stroke="#D9AFA9" strokeWidth="2" strokeDasharray="5 6" />
          <circle cx="700" cy="560" r="4" fill="#96C2A9" />
          <circle cx="1010" cy="560" r="4" fill="#96C2A9" />
          <circle cx="1010" cy="300" r="4" fill="#96C2A9" />
          <circle cx="1250" cy="700" r="4" fill="#D9AFA9" />
        </svg>
        <div className="welcome-marker welcome-marker--a"><i className="ok" /></div>
        <div className="welcome-marker welcome-marker--b"><i className="warn" /></div>

        {/* 순찰 로봇 — 위치는 usePatrolMotion 이 transform 으로만 갱신한다 */}
        <div className="welcome-robot" ref={robotRef}>
          <div className="welcome-robot__sweep" />
          <div className="welcome-robot__card"><i /></div>
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

      {/* ── 모듈 4장: 그리드 칸이 아니라 서로 어긋난 플로팅 카드 ── */}
      <ul className="welcome-modules">
        {MODULES.map((m, i) => (
          <li key={m} className="welcome-mod">
            <span className="idx mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="name">{m}</span>
            <span className="dot" />
          </li>
        ))}
      </ul>

      {/* ── 하단 경계에 걸쳐 잘리는 통계 카드 — "더 있다"는 암시 ── */}
      <div className="welcome-edge" aria-hidden="true">
        <div className="welcome-edge__t">누적 순찰 시간</div>
        <div className="welcome-edge__v"><b className="mono">—</b><span>/ h</span></div>
        <div className="welcome-spark">
          {SPARK.map((v, i) => (
            <i
              key={i}
              style={{ height: `${v}px`, background: i >= SPARK.length - 3 ? 'var(--bb-ok)' : undefined }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
