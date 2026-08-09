import { useSim } from '../SimContext.ts'
import { useLive } from '../live/LiveContext.tsx'
import type { Section } from '../live/contracts.d.ts'
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
 * @param {{ section: Section, onSection: (s: Section) => void }} props
 */
export default function Nav({ section, onSection }: { section: Section,
            onSection: (s: Section) => void }) {
  const { clock } = useSim()
  const { enabled } = useLive()
  const { user } = useAuth()

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
      {user && <span className="navrole">{roleText(user.role)}</span>}
      <div className="clock mono">{clock}</div>
      <UserMenu />
    </nav>
  )
}
