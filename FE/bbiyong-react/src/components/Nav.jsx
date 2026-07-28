import { useSim } from '../SimContext.js'
import { useLive } from '../live/LiveContext.jsx'
import UserMenu from './auth/UserMenu.jsx'

// 실서버 연결 상태 뱃지 + mock/live 전환.
// 연결 여부를 눈으로 확인할 수단이 없으면 이후 연동 작업이 전부 깜깜이가 되므로 상단에 상시 노출한다.
function LiveBadge() {
  const { enabled, connected, lastError, authError, hasToken, toggleDataSource } = useLive()

  let state = 'off', label = '시뮬레이션', hint = '클릭 시 실서버 모드로 전환'
  if (enabled) {
    if (!hasToken) {
      // 인증 강제(S15P11E101-418) 배포됨 — 토큰 없이는 CONNECT 자체가 거부된다.
      state = 'err'; label = '실서버 로그인 필요'
      hint = '시뮬레이션 계정으로 로그인해 JWT가 없습니다. 로그아웃 후 실서버 계정으로 다시 로그인하세요.'
    } else if (authError) { state = 'err'; label = '실서버 인증 거부'; hint = lastError || 'JWT 재발급이 필요합니다' }
    else if (!connected) { state = 'wait'; label = '실서버 연결 중…'; hint = lastError || '' }
    else { state = 'on'; label = '실서버 연결됨'; hint = '클릭 시 시뮬레이션 모드로 전환' }
  }

  return (
    <button className={`live-badge ${state}`} onClick={toggleDataSource} title={hint}>
      <i />{label}
    </button>
  )
}

export default function Nav() {
  const { activeTab, setTab, clock, status, actions, theme, toggleTheme } = useSim()
  return (
    <nav id="nav">
      <div className="logo">
        삐용(BBIYONG)
        <span style={{ fontSize: 11, color: '#7c8596', fontWeight: 400 }}> 통합 관제 시스템</span>
      </div>
      <div className="tabs">
        {/* 순찰 로봇 관제가 첫 페이지, CCTV 관제가 두 번째 페이지 */}
        <button className={activeTab === 'robot' ? 'on' : ''} onClick={() => setTab('robot')}>순찰 로봇 관제</button>
        <button className={activeTab === 'cctv' ? 'on' : ''} onClick={() => setTab('cctv')}>CCTV 관제</button>
      </div>
      <div className="sp" />
      <LiveBadge />
      <div className="demo">
        <span>이벤트 데모</span>
        <button className={status.fireOn ? 'on' : ''} onClick={actions.toggleFire}>
          {status.fireOn ? '화재 종료(조치 완료)' : '화재 발생'}
        </button>
        <button className={`heat${status.heatOn ? ' on' : ''}`} onClick={actions.toggleHeat}>
          {status.heatOn ? '과열 해제(조치 완료)' : '분전반 과열'}
        </button>
      </div>
      <button className="theme-btn" onClick={toggleTheme} aria-label="테마 전환">
        {theme === 'dark' ? '☀ 라이트 모드' : '🌙 다크 모드'}
      </button>
      <div className="clock mono">{clock}</div>
      <UserMenu />
    </nav>
  )
}
