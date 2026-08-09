// 진입(랜딩) 화면 — "안전한 공장을 위한 AIoT 자율순찰로봇" 히어로.
// 확정 시안: 수정한환영페이지.png (S15P11E101-877)
//
// 🔴 이전 판(v3 "플로팅 씬" — PatrolScene 아이소메트릭 순찰 씬 + 유리 히어로 패널,
// welcome-v5-B2)은 이 시안으로 통째로 폐기됐다. 배경은 텍스트 없는 정적 이미지
// (assets/welcome-hero.png, 좌측이 비어 있는 풀 배경) 한 장을 cover 로 깔고
// [사용자 지침 2026-08-09], 텍스트·CTA·기능 카드는 전부 그 앞에 띄운다.
//
// 하단 기능 카드 4종은 제품 소개 문구다 — 실데이터·수치가 아니므로 "로그인 전 랜딩에
// 더미 수치 금지" 지침[사용자 지침 2026-08-08]과 충돌하지 않는다.
//
// 색·타이포·radius·그림자는 한 값도 여기 적지 않는다. styles/tokens.css 의 --bb-* 를
// styles/app.css 의 .welcome-* 규칙이 참조한다. 시안의 강조 파랑은 --bb-hero-accent.

import heroImg from '../../assets/welcome-hero.png'

// 🔴 진입 애니메이션은 fill-mode:both 라 끝난 뒤에도 transform/opacity 를 계속 강제한다.
// 그 상태로는 전환용 transition(.authflow.is-login …)이 씹혀 요소가 물러나지 못한다 —
// 애니메이션이 끝나는 즉시 지운다. 자기 자신의 애니메이션만 본다(자식 것이 버블링된다).
const clearEntryAnim = (e: React.AnimationEvent<HTMLElement>) => {
  if (e.target === e.currentTarget) e.currentTarget.style.animation = 'none'
}

// 기능 카드 아이콘 — 시안의 파란 라인 아이콘 4종. 카드 밖에서 쓸 일이 없어 여기 둔다.
// 색은 CSS(currentColor)가 주고, 여기서는 형태만 그린다.
const IC = {
  fire: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21c3.9 0 6.5-2.5 6.5-6 0-2.6-1.6-4.5-3-6.2-1.2-1.5-2.4-2.9-2.7-4.8-2 1.4-3.1 3.3-3.3 5.2-.7-.5-1.3-1.2-1.6-2C6.3 8.7 5.5 10.9 5.5 13c0 4.5 2.6 8 6.5 8Z" />
      <path d="M12 21c-1.8 0-3-1.4-3-3.2 0-1.6 1.2-2.8 3-4.3 1.8 1.5 3 2.7 3 4.3 0 1.8-1.2 3.2-3 3.2Z" />
    </svg>
  ),
  plan: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16v16H4Z" />
      <path d="M12 4v6M12 14v6M4 12h5M15 12h5" />
    </svg>
  ),
  route: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" />
    </svg>
  ),
  bell: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M10.3 19a2 2 0 0 0 3.4 0" />
    </svg>
  ),
}

// 기능 카드 4종 — 문구는 시안 그대로. 설명의 줄바꿈 위치도 시안을 따른다.
const FEATURES = [
  { icon: IC.fire, title: '화재 감지', desc: <>AI로 화재를<br />신속하게 감지</> },
  { icon: IC.plan, title: '2D 도면 매핑', desc: <>정확한 지도 생성으로<br />효율적인 순찰</> },
  { icon: IC.route, title: '자율 주행 순찰', desc: <>스스로 경로를 계획하고<br />안전하게 순찰</> },
  { icon: IC.bell, title: '실시간 알림', desc: <>이상 상황을 즉시 감지하고<br />실시간으로 알림</> },
]

export default function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  return (
    <>
      {/* 배경 비주얼 — 장식이다. 내용은 히어로 텍스트가 전부 말하므로 보조기기에는 숨긴다. */}
      <img
        className="welcome-visual" src={heroImg} alt="" aria-hidden="true"
        draggable={false} onAnimationEnd={clearEntryAnim}
      />

      <section className="welcome-hero" onAnimationEnd={clearEntryAnim}>
        <p className="welcome-label">BBIYONG</p>

        <h1 className="welcome-head">
          안전한 공장을 위한<br /><em>AIoT</em> 자율순찰로봇
        </h1>

        <p className="welcome-desc">스스로 순찰하고, 스스로 감지하고, 즉시 알려줍니다.</p>

        <div className="welcome-cta-row">
          {/* Filled CTA 는 화면당 1개 */}
          <button className="welcome-cta" onClick={onEnter}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            관제시스템 접속
            <svg className="arr" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12h15M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </section>

      <ul className="welcome-features" aria-label="주요 기능">
        {FEATURES.map((f, i) => (
          /* stagger 는 인라인 지연으로 — CSS 에 카드 수만큼 nth-child 를 늘어놓지 않는다 */
          <li key={f.title} className="welcome-feature"
            style={{ animationDelay: `${0.35 + i * 0.12}s` }} onAnimationEnd={clearEntryAnim}>
            <span className="welcome-feature__ic">{f.icon}</span>
            <strong className="welcome-feature__t">{f.title}</strong>
            <span className="welcome-feature__d">{f.desc}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
