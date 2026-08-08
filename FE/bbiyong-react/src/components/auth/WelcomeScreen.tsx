// 진입(랜딩) 화면의 **앞면** — 히어로(브랜드·CTA).
//
// 🔴 배경 순찰 씬은 여기 없다 (S15P11E101-808). 씬은 웰컴과 로그인의 공통 부모
// (AuthFlow)에 있는 PatrolScene 이 그린다 — 로그인으로 넘어가도 언마운트되지 않아야
// 로봇이 멈추지 않는다. 이 컴포넌트는 "로그인으로 밀려나며 사라지는 쪽"만 담는다.
//
// 🔴 하단 2연 통계 카드(누적 순찰 시간 · 예상 구동 가능 시간)는 제거됐다
// [사용자 지침 2026-08-08]. 로그인 전 랜딩이라 붙일 실데이터가 없어 장식용 더미
// 수치를 넣었던 자리인데, 로그인도 하기 전에 사실이 아닌 숫자를 보여 주는 것이
// 문제였다. 카드를 만들려고 두었던 더미 데이터 배열·배율 상수도 함께 걷어냈다 —
// 소비자가 없는데 남겨 두면 "언젠가 쓸 값" 처럼 읽힌다.
//
// v3 디자인 시스템 "플로팅 씬" 배치 — 확정 시안 welcome-v5-B2 계열.
// 화면 끝까지 밝은 씬을 깔고, 정보는 그 위에 뜬다 — 좌우로 칸을 나누지 않는다.
// 레퍼런스의 좌측 로봇 목록 패널은 가져오지 않는다 — 우리 화면의 좌측은 히어로(브랜드·CTA)다.
//
// 색·타이포·radius·그림자는 한 값도 여기 적지 않는다. styles/tokens.css 의 --bb-* 를
// styles/app.css 의 .welcome-* 규칙이 참조한다.

// 🔴 진입 애니메이션(welcomeHeroRise)은 fill-mode:both 라 끝난 뒤에도
// transform/opacity 를 계속 강제한다. 그 상태로는 전환용 transition(.authflow.is-login …)이
// 씹혀 히어로가 밀려나지 않는다 — 애니메이션이 끝나는 즉시 지운다(시안이 브라우저에서
// 실제로 확인하고 넣은 처리다). 자기 자신의 애니메이션만 본다(자식 것이 버블링된다).
const clearEntryAnim = (e: React.AnimationEvent<HTMLElement>) => {
  if (e.target === e.currentTarget) e.currentTarget.style.animation = 'none'
}

export default function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  return (
    /* ── 히어로: 밝은 씬 위이므로 유리 패널을 쓴다(어두운 영상 위엔 금지) ── */
    <section className="welcome-hero" onAnimationEnd={clearEntryAnim}>
      <h1 className="welcome-brand">
        삐용<span className="dot">.</span><span className="en mono">BBIYONG</span>
      </h1>

      <p className="welcome-tag">공장 무인 안전<br />이상탐지 통합 관제 시스템</p>

      <p className="welcome-desc">
        순찰 로봇 오린카가 배전반 등 설비를 자율 순찰하며 온도 이상을 상시 감시합니다.<br />
        과열이 감지되면 즉시 경보로 이어지는 관제 콘솔입니다.
      </p>

      {/* 🔴 배전반 색(정상/과열)의 의미는 문구가 아니라 씬 우측 하단의 범례 컴포넌트가
          설명한다 [사용자 지침 2026-08-08] — PatrolScene.tsx 의 .welcome-scene-legend.
          "지도 화면 범례(#pgMap .maplegend)와 같은 문법을 재사용해라"는 지시에 따라
          새 시각 언어를 만들지 않았다. */}

      <div className="welcome-cta-row">
        {/* Filled CTA 는 화면당 1개 */}
        <button className="welcome-cta" onClick={onEnter}>관제 시스템 접속</button>
      </div>
    </section>
  )
}
