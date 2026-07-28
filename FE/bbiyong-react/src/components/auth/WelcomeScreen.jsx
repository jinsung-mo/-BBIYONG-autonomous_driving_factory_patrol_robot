// 진입(랜딩) 화면 — 로그인 전에 표시. "접속" → 로그인 화면으로 진입.
// 산업용 관제 콘솔 톤의 절제된 다크 레이아웃 (테마와 무관하게 항상 다크).

const MODULES = [
  '순찰 로봇',
  '열화상 과열 감시',
  '실시간 SLAM 맵핑',
  '웹 기반 관제',
]

export default function WelcomeScreen({ onEnter }) {
  return (
    <div
      className="welcome-wrap"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
    >
      <div className="welcome-inner">
        <div className="welcome-top">
          <span className="welcome-status"><i />SYSTEM ONLINE</span>
        </div>

        <h1 className="welcome-brand">삐용<span className="en">BBIYONG</span></h1>
        <p className="welcome-tag">공장 무인 안전 이상탐지 통합 관제 시스템</p>
        <p className="welcome-desc">
          순찰 로봇 오린카를 웹 콘솔에서 원격으로 운용합니다.<br />
          현장의 이상 징후를 상시 감시하고, 발생 즉시 대응 체계로 연결합니다.
        </p>

        <ul className="welcome-modules">
          {MODULES.map((m, i) => (
            <li key={m}>
              <span className="idx mono">{String(i + 1).padStart(2, '0')}</span>
              {m}
            </li>
          ))}
        </ul>

        <button className="welcome-cta" onClick={onEnter}>관제 시스템 접속</button>

        <div className="welcome-foot mono">BBIYONG CONTROL · v1.0 · © 2026 E101</div>
      </div>
    </div>
  )
}
