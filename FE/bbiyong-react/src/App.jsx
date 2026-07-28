import { useState } from 'react'
import useSimulation from './hooks/useSimulation.js'
import { SimContext } from './SimContext.js'
import { AuthProvider, useAuth } from './auth/AuthContext.jsx'
import { LiveProvider } from './live/LiveContext.jsx'
import LiveSimBridge from './live/LiveSimBridge.jsx'
import WelcomeScreen from './components/auth/WelcomeScreen.jsx'
import AuthScreen from './components/auth/AuthScreen.jsx'
import Nav from './components/Nav.jsx'
import RobotPage from './components/robot/RobotPage.jsx'
import EventAlert from './components/EventAlert.jsx'

// 로그인 상태에서만 마운트 → 시뮬레이션 루프도, STOMP 연결도 로그인 후에만 시작
function Dashboard() {
  const sim = useSimulation()
  return (
    <SimContext.Provider value={sim}>
      <LiveProvider>
        {/* live 모드일 때 실서버 위치·영상 프레임을 캔버스 렌더러로 밀어 넣는다 */}
        <LiveSimBridge />
        <Nav />
        {/* 화재/과열 발생 팝업 알림 — 항상 최상단에 떠 있음 */}
        <EventAlert />
        <RobotPage />
      </LiveProvider>
    </SimContext.Provider>
  )
}

// 로그아웃 상태: Welcome(랜딩) → 로그인. 로그인 성공 시 대시보드(순찰 로봇 관제)로 진입.
function Gate() {
  const { user } = useAuth()
  const [entered, setEntered] = useState(false) // Welcome을 지나 로그인 화면으로 들어왔는지

  if (user) return <Dashboard />
  if (!entered) return <WelcomeScreen onEnter={() => setEntered(true)} />
  return <AuthScreen onBack={() => setEntered(false)} />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
