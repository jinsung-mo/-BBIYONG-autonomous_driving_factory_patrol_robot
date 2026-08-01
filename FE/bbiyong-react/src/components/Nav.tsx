import { useSim } from '../SimContext.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import { roleText } from '../auth/roles.ts'
import UserMenu from './auth/UserMenu.tsx'

// 데이터 소스(시뮬/실서버)는 로그인 화면에서 선택한다.
// 세션 중 전환은 토큰과 어긋날 수 있어(로그인한 모드가 JWT 보유 여부를 결정) 상단에서 제거했다.
// 실서버 연결 상태는 수동 조작 패널 헤더의 LIVE / DISCONNECTED 표시로 확인한다.
//
// 섹션 탭(S15P11E101-475): 관제는 상시, 운영·설정은 관리자에게만 보인다.
// 뷰어에게 탭 자체를 감추는 이유는 눌러도 못 들어가는 문을 만들지 않기 위해서다.
// (반대로 관제 화면의 조작 버튼은 감추지 않고 회색으로 남긴다 — 기능이 없는 게 아니라 권한이 없는 것)
/**
 * @param {{ section: 'live' | 'ops' | 'config',
 *           onSection: (s: 'live' | 'ops' | 'config') => void }} props
 */
export default function Nav({ section, onSection }) {
  const { clock, theme, toggleTheme } = useSim()
  const { user, isAdmin } = useAuth()

  // key 를 리터럴로 고정한다 — 그냥 두면 string 으로 넓어져 onSection 이 받지 못한다.
  /** @type {Array<{ key: 'live' | 'ops' | 'config', label: string }>} */
  const tabs = [
    { key: 'live', label: '관제' },
    ...(isAdmin
      ? /** @type {Array<{ key: 'live' | 'ops' | 'config', label: string }>} */ ([
        { key: 'ops', label: '운영' }, { key: 'config', label: '설정' },
      ])
      : []),
  ]

  return (
    <nav id="nav">
      <div className="logo">
        삐용(BBIYONG)
        <span style={{ fontSize: 11, color: '#7c8596', fontWeight: 400 }}> 순찰 로봇 관제</span>
      </div>
      <div className="navtabs" role="tablist" aria-label="화면 전환">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={section === t.key}
            className={section === t.key ? 'on' : ''}
            onClick={() => onSection(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="sp" />
      {user && <span className="navrole">{roleText(user.role)}</span>}
      <button className="theme-btn" onClick={toggleTheme} aria-label="테마 전환">
        {theme === 'dark' ? '☀ 라이트 모드' : '🌙 다크 모드'}
      </button>
      <div className="clock mono">{clock}</div>
      <UserMenu />
    </nav>
  )
}
