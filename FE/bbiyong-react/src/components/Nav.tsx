import { useEffect, useState } from 'react'
import { useSim } from '../SimContext.ts'
import { useLive } from '../live/LiveContext.tsx'
import type { Section } from '../live/contracts.d.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import { roleText } from '../auth/roles.ts'
import UserMenu from './auth/UserMenu.tsx'
import HelpGuide from './HelpGuide.tsx'

// 처음 접속한 사용자에게는 설명서를 한 번 자동으로 띄운다(S15P11E101-911) — 관제센터
// 안전감시 담당자가 무엇을 보는 화면인지 바로 이해하도록. 이후에는 상단 버튼으로만 연다.
const HELP_SEEN_KEY = 'bbiyong.help.seen'

// 데이터 소스(시뮬/실서버)는 로그인 화면에서 선택한다.
// 세션 중 전환은 토큰과 어긋날 수 있어(로그인한 모드가 JWT 보유 여부를 결정) 상단에서 제거했다.
// 실서버 연결 상태는 수동 조작 패널 헤더의 LIVE / DISCONNECTED 표시로 확인한다.
//
// 섹션 탭(S15P11E101-475): 관제는 상시, 운영·설정은 관리자에게만 보인다.
// 뷰어에게 탭 자체를 감추는 이유는 눌러도 못 들어가는 문을 만들지 않기 위해서다.
// (반대로 관제 화면의 조작 버튼은 감추지 않고 회색으로 남긴다 — 기능이 없는 게 아니라 권한이 없는 것)
/**
 * @param {{ section: Section, onSection: (s: Section) => void }} props
 */
export default function Nav({ section, onSection }: { section: Section,
            onSection: (s: Section) => void }) {
  const { clock } = useSim()
  const { enabled } = useLive()
  const { user } = useAuth()
  const [helpOpen, setHelpOpen] = useState(false)

  // 첫 접속이면 설명서를 자동으로 한 번 연다. localStorage 에 표시가 없을 때만.
  useEffect(() => {
    try {
      if (!localStorage.getItem(HELP_SEEN_KEY)) setHelpOpen(true)
    } catch { /* localStorage 차단 환경 — 자동 노출만 생략한다 */ }
  }, [])
  const closeHelp = () => {
    setHelpOpen(false)
    try { localStorage.setItem(HELP_SEEN_KEY, '1') } catch { /* 무시 */ }
  }

  // 지도, 카메라, 이벤트 세 화면을 제공한다.
  // (S15P11E101 콘솔 정리) 통계·운영 탭 삭제 — 매핑·순찰 경로는 지도 탭으로 이동했다.
  // 설정 탭도 제거했다(2026-08-09) — 매핑/순찰 시작은 지도 탭에 있고 나머지는 쓰지 않는다.
  const tabs: Array<{ key: Section, label: string }> = [
    { key: 'live' as const, label: '지도' },
    { key: 'cam' as const, label: '카메라' },
    { key: 'events' as const, label: '이벤트' },
  ]

  return (
    <nav id="nav" className="sim-nav">
      <div className="logo">
        삐용(BBIYONG)
        <span className="nav-subtitle"> 순찰 로봇 관제</span>
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
      {/* 사용설명서 — 눈에 잘 띄게 상단에 상시 배치(안전감시 담당자용). */}
      <button type="button" className="nav-help-btn" onClick={() => setHelpOpen(true)} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 013.9-2c1 .6 1.1 1.8.4 2.6-.6.7-1.8.9-1.8 2.1" /><path d="M12 17h.01" />
        </svg>
        사용설명서
      </button>
      {user && <span className="navrole">{roleText(user.role)}</span>}
      <div className="clock mono">{clock}</div>
      <UserMenu />
      {helpOpen && <HelpGuide onClose={closeHelp} />}
    </nav>
  )
}
