import { useState } from 'react'
import useSimulation from './hooks/useSimulation.js'
import { SimContext } from './SimContext.js'
import { AuthProvider, useAuth } from './auth/AuthContext.jsx'
import WelcomeScreen from './components/auth/WelcomeScreen.jsx'
import AuthScreen from './components/auth/AuthScreen.jsx'
import Nav from './components/Nav.jsx'
import CctvPage from './components/cctv/CctvPage.jsx'
import RobotPage from './components/robot/RobotPage.jsx'

// 로그인 상태에서만 마운트 → 시뮬레이션 루프도 로그인 후에만 시작
function Dashboard() {
  const sim = useSimulation()
  return (
    <SimContext.Provider value={sim}>
      <Nav />
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
