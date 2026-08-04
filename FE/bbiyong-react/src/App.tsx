import { useState } from 'react'
import useSimulation from './hooks/useSimulation.ts'
import { SimContext } from './SimContext.ts'
import { AuthProvider, useAuth } from './auth/AuthContext.tsx'
import { LiveProvider, useLive } from './live/LiveContext.tsx'
import type { Section } from './live/contracts.d.ts'
import LiveSimBridge from './live/LiveSimBridge.tsx'
import { FleetProvider } from './live/FleetContext.tsx'
import WelcomeScreen from './components/auth/WelcomeScreen.tsx'
import AuthScreen from './components/auth/AuthScreen.tsx'
import Nav from './components/Nav.tsx'
import RobotPage from './components/robot/RobotPage.tsx'
import MapPage from './components/robot/MapPage.tsx'
import CameraPage from './components/robot/CameraPage.tsx'
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
// 관제 화면 본체. LiveProvider 안쪽이라야 mock/live 를 알 수 있어 따로 뺐다.
//
// 시뮬레이션에서는 관제를 두 화면으로 나눈다 — 지도와 카메라.
// 한 화면에 다 넣으면 어느 것도 크지 않다. 지도는 구역 전체를 봐야 하고 영상은
// 무엇이 찍혔는지 봐야 하는데, 둘 다 작으면 둘 다 못 본다.
//
// 실서버 화면은 지금 배치를 그대로 둔다 — 운영 중인 화면을 시연용 개편과 한 번에
// 바꾸지 않는다(S15P11E101-646 이후 계속 지켜 온 원칙).
function Sections({ active, isAdmin }: { active: Section, isAdmin: boolean }) {
  const { enabled } = useLive()
  return (
    <>
      {enabled ? (
        <div hidden={active !== 'live'}><RobotPage /></div>
      ) : (
        <>
          {/* 두 화면 모두 마운트해 둔다. 탭을 옮겼다고 캔버스를 버리면 돌아올 때마다
              영상과 지도가 처음부터 다시 붙는다. */}
          <div hidden={active !== 'live'}><MapPage /></div>
          <div hidden={active !== 'cam'}><CameraPage /></div>
        </>
      )}
      {isAdmin && active === 'ops' && <OpsPage />}
      {isAdmin && active === 'config' && <ConfigPage />}
    </>
  )
}

function Dashboard() {
  const sim = useSimulation()
  const { isAdmin } = useAuth()
  const [section, setSection] = useState<Section>('live')
  // 권한이 줄어드는 경우(관리자 → 뷰어 계정으로 재로그인)를 대비해 접근 가능한 섹션으로 되돌린다
  const active = !isAdmin && section !== 'live' && section !== 'cam' ? 'live' : section

  return (
    <SimContext.Provider value={sim}>
      <SettingsProvider>
        <LiveProvider>
          {/* 편성 전체 상태(대시보드 집계)를 한 번 받아 나눠 쓴다(S15P11E101-591) */}
          <FleetProvider>
            {/* live 모드일 때 실서버 위치·영상 프레임을 캔버스 렌더러로 밀어 넣는다 */}
            <LiveSimBridge />
            {/* 이벤트 로그가 기록되는 동안 세션을 유지한다(S15P11E101-508) */}
            <EventLogActivity />
            <Nav section={active} onSection={setSection} />
            {/* 화재/과열 발생 팝업 알림 — 어느 탭에 있든 항상 최상단에 떠 있음 */}
            <EventAlert />
            <Sections active={active} isAdmin={isAdmin} />
          </FleetProvider>
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
