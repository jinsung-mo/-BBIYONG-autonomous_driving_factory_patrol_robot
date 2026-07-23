import { useSim } from '../SimContext.js'
import UserMenu from './auth/UserMenu.jsx'

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
