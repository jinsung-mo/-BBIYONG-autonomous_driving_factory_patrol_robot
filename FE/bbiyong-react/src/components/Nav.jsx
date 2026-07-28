import { useSim } from '../SimContext.js'
import UserMenu from './auth/UserMenu.jsx'

// 데이터 소스(시뮬/실서버)는 로그인 화면에서 선택한다.
// 세션 중 전환은 토큰과 어긋날 수 있어(로그인한 모드가 JWT 보유 여부를 결정) 상단에서 제거했다.
// 실서버 연결 상태는 수동 조작 패널 헤더의 LIVE / DISCONNECTED 표시로 확인한다.
export default function Nav() {
  const { clock, theme, toggleTheme } = useSim()
  return (
    <nav id="nav">
      <div className="logo">
        삐용(BBIYONG)
        <span style={{ fontSize: 11, color: '#7c8596', fontWeight: 400 }}> 순찰 로봇 관제</span>
      </div>
      <div className="sp" />
      <button className="theme-btn" onClick={toggleTheme} aria-label="테마 전환">
        {theme === 'dark' ? '☀ 라이트 모드' : '🌙 다크 모드'}
      </button>
      <div className="clock mono">{clock}</div>
      <UserMenu />
    </nav>
  )
}
