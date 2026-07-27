import { useState } from 'react'
import useSimulation from './hooks/useSimulation'
import { SimContext } from './SimContext'
import { AuthProvider, useAuth } from './auth/AuthContext'
import WelcomeScreen from './components/auth/WelcomeScreen'
import AuthScreen from './components/auth/AuthScreen'
import Nav from './components/Nav'
import CctvPage from './components/cctv/CctvPage'
import RobotPage from './components/robot/RobotPage'
import EventAlert from './components/EventAlert'

// 로그인 상태에서만 마운트 → 시뮬레이션 루프도 로그인 후에만 시작
function Dashboard() {
  const sim = useSimulation()
  return (
    <SimContext.Provider value={sim}>
      <Nav />
      {/* 화재/과열 발생 팝업 알림 — 탭과 무관하게 항상 최상단에 떠 있음 */}
      <EventAlert />
      {/* 순찰 로봇 관제가 첫 페이지, CCTV 관제가 두 번째 페이지 */}
      <RobotPage active={sim.activeTab === 'robot'} />
      <CctvPage active={sim.activeTab === 'cctv'} />
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
