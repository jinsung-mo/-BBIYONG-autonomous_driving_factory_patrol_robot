// 로그아웃 상태의 화면 하나 — 웰컴과 로그인은 **두 화면이 아니라 한 화면의 두 상태**다.
// 확정 시안: docs/design/mockups/flow-welcome-to-login.html (S15P11E101-808)
//
// ══ 왜 삼항 교체를 버렸나 ═══════════════════════════════════════════════════
// 전에는 App.tsx 의 Gate 가 `entered ? <AuthScreen/> : <WelcomeScreen/>` 으로 둘 중
// 하나만 렌더했다. 그 구조로는 두 가지가 원리적으로 불가능하다.
//   ① 배경 순찰 씬이 살아남지 못한다 — 씬이 WelcomeScreen 안에 있어서 로그인으로 가는
//      순간 언마운트되고, 돌아오면 로봇이 경로 시작점부터 다시 돈다.
//   ② 나가는 화면이 애니메이션을 마칠 수 없다 — 교체 즉시 DOM 에서 사라지므로
//      "왼쪽으로 밀려나며 사라진다"가 그려질 프레임 자체가 없다.
// → 씬(PatrolScene)을 두 상태의 공통 부모인 여기로 끌어올리고, 웰컴과 로그인을 **동시에
//   마운트**해 둔 채 CSS 클래스로만 전환한다. 나가는 쪽은 DOM 에 그대로 남아 transition 을
//   끝까지 재생하고, 끝난 뒤에도 opacity 0 · pointer-events:none · inert 로 죽어 있다.
//
// ══ 데이터 흐름 ════════════════════════════════════════════════════════════
// CTA 클릭 → goLogin() → is-login 즉시 ON(히어로 퇴장 · 스크림 · 통계 페이드)
//          → 70ms 뒤 login-in ON(로그인 패널 등장)
// ← 처음으로 → goWelcome() → login-in 즉시 OFF → 70ms 뒤 is-login OFF
// 로봇 좌표는 이 전환과 무관하게 PatrolScene 안의 rAF 루프가 계속 갱신한다(리렌더 없음).
//
// 🔴 시차를 CSS transition-delay 로 주지 않는 이유: delay 는 켤 때와 끌 때가 대칭이라
// 왕복에서 반대로 작동한다(들어올 때 늦어야 할 쪽이 나갈 때도 늦어진다). 방향마다
// "먼저 끄고 늦게 켠다"를 뒤집어야 하므로 JS 타이머로 두 클래스를 시차 토글한다.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import PatrolScene from './PatrolScene.tsx'
import WelcomeScreen from './WelcomeScreen.tsx'
import AuthScreen from './AuthScreen.tsx'

// 겹침 시차. 시안이 정한 60~80ms 권장 범위의 중간값 — 나가는 쪽이 먼저 움직이기 시작하고
// 들어오는 쪽이 그 위에 얹힌다. 이동을 끄는 사용자에게는 시차도 의미가 없으므로 0.
const STAGGER_MS = 70

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function AuthFlow() {
  const { logoutReason } = useAuth()

  // 자동 로그아웃으로 들어왔으면 랜딩을 거치지 않고 곧바로 로그인 상태에서 시작한다 —
  // 사유(warn)를 바로 읽을 수 있어야 한다. 이때는 전환 애니메이션도 없다(처음부터 켜져 있음).
  const startAtLogin = !!logoutReason
  const [isLogin, setIsLogin] = useState(startAtLogin)   // 히어로 퇴장 · 스크림 · 통계 페이드
  const [loginIn, setLoginIn] = useState(startAtLogin)   // 로그인 패널 등장

  const rootRef = useRef<HTMLDivElement>(null)
  const welcomeRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 왕복 연타를 견디는 지점. 진행 중 반대 방향이 들어오면 대기 중인 타이머를 먼저 지운다 —
  // 지우지 않으면 뒤늦게 깨어난 타이머가 방금 바꾼 상태를 되돌린다.
  const goLogin = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setIsLogin(true)
    const wait = prefersReducedMotion() ? 0 : STAGGER_MS
    timer.current = setTimeout(() => setLoginIn(true), wait)
  }, [])

  const goWelcome = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setLoginIn(false)
    const wait = prefersReducedMotion() ? 0 : STAGGER_MS
    timer.current = setTimeout(() => setIsLogin(false), wait)
  }, [])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // 보이지 않는 쪽은 키보드에서도 닫아야 한다. opacity 0 만으로는 Tab 이 그대로 들어가
  // 화면에 없는 입력란에 포커스가 잡힌다. inert 는 React 18 의 타입에 없어 DOM 으로 건다.
  // 로그인 패널은 AuthScreen 이 자기 루트를 그리므로 여기서 질의해 잡는다.
  useEffect(() => {
    const w = welcomeRef.current as (HTMLDivElement & { inert?: boolean }) | null
    const a = rootRef.current?.querySelector('.auth-wrap') as (HTMLElement & { inert?: boolean }) | null
    if (w) w.inert = isLogin
    if (a) a.inert = !loginIn
  }, [isLogin, loginIn])

  return (
    <div ref={rootRef} className={`authflow${isLogin ? ' is-login' : ''}${loginIn ? ' login-in' : ''}`}>
      {/* 웰컴 층 — 씬(계속 살아 있음) + 히어로·통계(로그인에서 퇴장) */}
      <div
        ref={welcomeRef}
        className="welcome-wrap"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' && !isLogin) goLogin() }}
      >
        <PatrolScene />
        <WelcomeScreen onEnter={goLogin} />
      </div>

      {/* 스크림 — 블러를 전담한다. 🔴 씬에 filter 를 걸지 않는 이유 두 가지:
          ① filter 는 조상에 containing block 을 만들어 position:fixed 자식이 깨진다.
          ② 매 프레임 transform 이 도는 씬에 blur 를 걸면 GPU 가 매 프레임 다시 흐린다.
          스크림은 뒤(씬)만 흐리므로 씬은 원래 비용 그대로 돈다. */}
      <div className="scrim" aria-hidden="true" />

      {/* 로그인 층 — 아래에서 올라온다. 항상 마운트돼 있고 클래스로만 여닫는다. */}
      <AuthScreen onBack={goWelcome} />
    </div>
  )
}
