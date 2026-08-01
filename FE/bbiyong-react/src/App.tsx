import { useState } from 'react'
import useSimulation from './hooks/useSimulation.ts'
import { SimContext } from './SimContext.ts'
import { AuthProvider, useAuth } from './auth/AuthContext.tsx'
import { LiveProvider } from './live/LiveContext.tsx'
import LiveSimBridge from './live/LiveSimBridge.tsx'
import WelcomeScreen from './components/auth/WelcomeScreen.tsx'
import AuthScreen from './components/auth/AuthScreen.tsx'
import Nav from './components/Nav.tsx'
import RobotPage from './components/robot/RobotPage.tsx'
import OpsPage from './components/ops/OpsPage.tsx'
import ConfigPage from './components/config/ConfigPage.tsx'
import EventAlert from './components/EventAlert.tsx'
import { SettingsProvider } from './settings/SettingsContext.tsx'
import SessionWatcher from './auth/SessionWatcher.tsx'
import EventLogActivity from './auth/EventLogActivity.tsx'

// 로그인 상태에서만 마운트 → 시뮬레이션 루프도, STOMP 연결도 로그인 후에만 시작
//
// 섹션 구성(S15P11E101-475): 관제(모니터링 + 실시간 개입) / 운영 / 설정.
// 관제 화면은 계속 마운트해 둔다 — 탭을 옮겼다고 캔버스와 STOMP 구독을 버리면
// 돌아올 때마다 맵과 영상이 처음부터 다시 붙는다.
function Dashboard() {
  const sim = useSimulation()
  const { isAdmin } = useAuth()
  const [section, setSection] = useState('live')
  // 권한이 줄어드는 경우(관리자 → 뷰어 계정으로 재로그인)를 대비해 접근 가능한 섹션으로 되돌린다
  const active = !isAdmin && section !== 'live' ? 'live' : section

  return (
    <SimContext.Provider value={sim}>
      <SettingsProvider>
        <LiveProvider>
          {/* live 모드일 때 실서버 위치·영상 프레임을 캔버스 렌더러로 밀어 넣는다 */}
          <LiveSimBridge />
          {/* 이벤트 로그가 기록되는 동안 세션을 유지한다(S15P11E101-508) */}
          <EventLogActivity />
          <Nav section={active} onSection={setSection} />
          {/* 화재/과열 발생 팝업 알림 — 어느 탭에 있든 항상 최상단에 떠 있음 */}
          <EventAlert />
          <div hidden={active !== 'live'}><RobotPage /></div>
          {isAdmin && active === 'ops' && <OpsPage />}
          {isAdmin && active === 'config' && <ConfigPage />}
        </LiveProvider>
      </SettingsProvider>
    </SimContext.Provider>
  )
}

// 로그아웃 상태: Welcome(랜딩) → 로그인. 로그인 성공 시 대시보드(순찰 로봇 관제)로 진입.
function Gate() {
  const { user, logoutReason } = useAuth()
  const [entered, setEntered] = useState(false) // Welcome을 지나 로그인 화면으로 들어왔는지

  // 자동 로그아웃되면 랜딩이 아니라 로그인 화면으로 보낸다 — 사유를 바로 읽을 수 있어야 한다
  if (user) return <><SessionWatcher /><Dashboard /></>
  if (!entered && !logoutReason) return <WelcomeScreen onEnter={() => setEntered(true)} />
  return <AuthScreen onBack={() => setEntered(false)} />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
