import { useState, useEffect } from 'react'
import useSimulation from './hooks/useSimulation.ts'
import { SimContext } from './SimContext.ts'
import { AuthProvider, useAuth } from './auth/AuthContext.tsx'
import { LiveProvider, useLive } from './live/LiveContext.tsx'
import type { Section } from './live/contracts.d.ts'
import LiveSimBridge from './live/LiveSimBridge.tsx'
import { ZoneProvider } from './live/ZoneContext.tsx'
import { FleetProvider } from './live/FleetContext.tsx'
import AuthFlow from './components/auth/AuthFlow.tsx'
import Nav from './components/Nav.tsx'
import RobotPage from './components/robot/RobotPage.tsx'
import MapPage from './components/robot/MapPage.tsx'
import type { MapTab } from './components/robot/MapPage.tsx'
import KpiRow from './components/robot/KpiRow.tsx'
import CameraPage from './components/robot/CameraPage.tsx'
import EventPage from './components/events/EventPage.tsx'
import EventAlert from './components/EventAlert.tsx'
import Modal from './components/ui/Modal.tsx'
import { useMappingControl } from './live/useMappingControl.ts'
import ErrorBoundary from './components/ErrorBoundary.tsx'
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
//
// 화면 전환은 세로 슬라이드다. 네 화면을 탭 순서대로 위→아래로 쌓아 두고, 활성 화면의
// 인덱스만큼 트랙을 끌어올린다 — 카메라를 누르면 카메라가 아래에서 올라오며 지도를 위로
// 밀어내고, 지도를 다시 누르면 그 반대로 되돌아온다.
// 위치를 눈으로 보여 주는 것이 목적이므로 순서는 상단 탭(Nav.tsx)과 반드시 같아야 한다.
//
// 🔴 움직이는 것은 본문뿐이다. 제목·KPI·보조 줄은 아래 ConsoleHeader 로 끌어올려 고정한다 —
// 화면마다 하나씩 들고 있으면 탭을 옮길 때 머리까지 같이 밀려 올라가고, 그러면 '틀 안에서
// 내용이 바뀐다'가 아니라 '화면이 통째로 굴러간다'로 보인다.

// 화면별 제목. 머리가 공유물이 되었으니 문구도 한곳에 모은다.
const SECTION_TITLE: Record<Section, { title: string, sub: string }> = {
  // 영문 부제(ORINCA FLEET / FRONT · THERMAL)는 제거했다(사용자 요청 2026-08-10).
  live: { title: '순찰 구역', sub: '' },
  cam: { title: '순찰 카메라 뷰', sub: '' },
  events: { title: '이벤트 로그', sub: 'EVENT ARCHIVE · REALTIME ALERTS' },
}

// 고정 머리 — 제목 + KPI + 보조 줄.
// `page v3-theme` 를 그대로 다는 이유는 app.css `.nav-shell` 주석에 적어 두었다(서식이
// 전부 그 스코프에 걸려 있다). 보조 줄은 지도에서만 채워지고, 나머지 탭에서는 빈 채로
// 자리만 지킨다 — 그래야 아래 본문이 시작하는 높이가 네 화면 모두 같다.
function ConsoleHeader({ active, isAdmin, mapTab, onMapTab }: {
  active: Section, isAdmin: boolean,
  mapTab: MapTab, onMapTab: (t: MapTab) => void,
}) {
  const { title, sub } = SECTION_TITLE[active]
  // 맵 모델링 컨트롤은 서브탭 줄 오른쪽에 둔다(S15P11E101-904). 로직은 훅에 있고
  // 여기서는 버튼·확인 모달만 그린다. 매핑 서브탭일 때만 노출한다.
  const mapping = useMappingControl()
  const showMapping = active === 'live' && isAdmin && mapTab === 'mapping'
  return (
    <header className="nav-shell page on v3-theme">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>{title}</h2>
          <span className="nav-sub">{sub}</span>
        </div>
        <KpiRow />
      </div>
      <div className="nav-subrow">
        {active === 'live' && isAdmin && (
          <div className="map-tabs" role="tablist" aria-label="지도 또는 매핑">
            <button type="button" role="tab" aria-selected={mapTab === 'map'} className={mapTab === 'map' ? 'on' : ''} onClick={() => onMapTab('map')}>지도</button>
            <button type="button" role="tab" aria-selected={mapTab === 'mapping'} className={mapTab === 'mapping' ? 'on' : ''} onClick={() => onMapTab('mapping')}>매핑</button>
          </div>
        )}
        {showMapping && (
          <div className="subrow-mapctl">
            {mapping.phase === 'complete' && <span className="subrow-mapstat done">매핑 완료</span>}
            {mapping.phase === 'requested' && <span className="subrow-mapstat wait">시작 대기…</span>}
            {(mapping.phase === 'running' || mapping.phase === 'requested') && (
              <button type="button" id="btnStopMapping" className="btn-tonal" style={{ color: '#B4655C' }}
                onClick={mapping.onStopMapping} disabled={mapping.offline}>매핑 중단</button>
            )}
            <button type="button" id="btnStartMapping" className="btn-filled"
              onClick={() => mapping.setConfirming(true)}
              disabled={mapping.offline || mapping.phase === 'running' || mapping.phase === 'requested'}>
              {mapping.phase === 'running' ? '매핑 진행 중…' : '맵 모델링 시작'}
            </button>
          </div>
        )}
      </div>
      {showMapping && mapping.confirming && (
        <Modal title="맵 모델링을 시작할까요?" onClose={() => mapping.setConfirming(false)} width={420}>
          <p className="cfg-help" style={{ marginBottom: 12 }}>
            로봇이 <b>순찰을 멈추고</b> 공장 안을 자율 주행하며 새 2D 맵을 만듭니다.
            주행 경로에 사람이나 장애물이 없는지 확인한 뒤 시작하세요.
          </p>
          <div className="gotor">
            <button type="button" className="btn-text" onClick={() => mapping.setConfirming(false)}>취소</button>
            <button type="button" id="btnStartMappingOk" className="btn-filled" onClick={mapping.onStart}>시작</button>
          </div>
        </Modal>
      )}
    </header>
  )
}

function Sections({ active, mapTab }: { active: Section, mapTab: MapTab }) {
  // 세 화면(지도·카메라·이벤트)을 탭 순서대로 쌓는다. translateY 의 % 는 트랙 자신의
  // 높이(= 본문 한 칸) 기준이라 슬롯 수와 무관하게 계산이 그대로다.
  const order: Section[] = ['live', 'cam', 'events']
  // active 는 Dashboard 에서 allowed 로 이미 보정됐지만, indexOf 가 -1 이면 트랙이
  // 화면 밖으로 나가 아무것도 안 보인다. 여기서 한 번 더 바닥을 깐다.
  const index = Math.max(0, order.indexOf(active))

  return (
    <div className="page-viewport">
      <div className="page-track" style={{ transform: `translateY(-${index * 100}%)` }}>
        {/* 화면 모두 마운트해 둔다. 탭을 옮겼다고 캔버스를 버리면 돌아올 때마다
            영상과 지도가 처음부터 다시 붙는다. 슬라이드는 나가고 들어오는 두 화면이
            동시에 그려져 있어야 성립한다. */}
        {order.map((key) => (
          <div key={key} className={`page-slot${active === key ? ' on' : ''}`}>
            {/* 화면 하나가 렌더 중 죽어도 나머지 셋은 살아 있어야 한다(S15P11E101-897).
                경계를 슬롯마다 하나씩 두는 이유가 여기 있다 — 네 화면이 한 나무에
                같이 매달려 있어서, 경계가 없으면 어느 하나의 예외가 넷을 다 지운다.
                `.page-slot` 은 위치 기준이 아니라 평범한 블록이라 `fill={false}` 다. */}
            <ErrorBoundary what={`${SECTION_TITLE[key].title} 화면`} fill={false}>
              {key === 'live' && <MapPage tab={mapTab} />}
              {key === 'cam' && <CameraPage />}
              {key === 'events' && <EventPage />}
            </ErrorBoundary>
          </div>
        ))}
      </div>
    </div>
  )
}

function Dashboard() {
  const sim = useSimulation()
  // isAdmin 은 지도 탭의 '지도/매핑' 세그먼트 노출에만 쓴다(ConsoleHeader).
  const { isAdmin } = useAuth()
  const [section, setSection] = useState<Section>(() => (sessionStorage.getItem('section') as Section) || 'live')
  useEffect(() => { sessionStorage.setItem('section', section) }, [section])
  // 접근 가능한 섹션으로 되돌린다. 삭제된 옛 섹션(통계/운영/설정)이 sessionStorage 에
  // 남아 있으면 지도로 보정한다.
  const allowed: Section[] = ['live', 'cam', 'events']
  const active: Section = allowed.includes(section) ? section : 'live'

  // 지도 화면의 '지도/매핑' 상태를 여기로 올린다. 세그먼트 자체는 고정된 머리에 있고
  // 그 결과를 그리는 것은 트랙 안의 지도 화면이라, 둘의 공통 부모가 이 값을 들어야 한다.
  const [mapTab, setMapTab] = useState<MapTab>('map')

  // 상단바는 페이지 밖에 있어 페이지 배경을 물려받지 못한다. 문서 뿌리에 표시를
  // 달아 배경을 뿌리로 올리고 상단바는 비운다 — 가로로 남는 흰 띠가 사라진다.
  // 이제 모든 화면이 같은 톤이라 탭을 가리지 않는다.
  const v3Page = true
  useEffect(() => {
    document.documentElement.classList.toggle('v3-page', v3Page)
    return () => document.documentElement.classList.remove('v3-page')
  }, [v3Page])

  return (
    <SimContext.Provider value={sim}>
      <SettingsProvider>
        <LiveProvider>
          {/* 편성 전체 상태(대시보드 집계)를 한 번 받아 나눠 쓴다(S15P11E101-591) */}
          <FleetProvider>
            {/* 구역 목록·랜드마크를 한 번만 받아 화면들이 나눠 쓴다(S15P11E101-770) */}
            <ZoneProvider>
            {/* live 모드일 때 실서버 위치·영상 프레임을 캔버스 렌더러로 밀어 넣는다 */}
            <LiveSimBridge />
            {/* 이벤트 로그가 기록되는 동안 세션을 유지한다(S15P11E101-508) */}
            <EventLogActivity />
            <Nav section={active} onSection={setSection} />
            {/* 화재/과열 발생 팝업 알림 — 어느 탭에 있든 항상 최상단에 떠 있음 */}
            <EventAlert />
            {/* 머리는 고정, 본문만 슬라이드 — 둘을 한 껍데기에 담아 여백·배경을 공유한다 */}
            <div className="console-shell">
              <ConsoleHeader active={active} isAdmin={isAdmin} mapTab={mapTab} onMapTab={setMapTab} />
              <Sections active={active} mapTab={mapTab} />
            </div>
            </ZoneProvider>
          </FleetProvider>
        </LiveProvider>
      </SettingsProvider>
    </SimContext.Provider>
  )
}

// 로그아웃 상태: Welcome(랜딩) ↔ 로그인. 로그인 성공 시 대시보드(순찰 로봇 관제)로 진입.
//
// 랜딩과 로그인은 더 이상 두 화면이 아니라 한 화면(AuthFlow)의 두 상태다(S15P11E101-808).
// 여기서 삼항으로 갈랐더니 배경 순찰 씬이 매번 언마운트돼 로봇이 처음부터 다시 돌았고,
// 나가는 화면이 애니메이션을 마칠 프레임도 없었다. 상태 전환은 AuthFlow 안에서 한다.
// (자동 로그아웃 사유는 AuthFlow 가 직접 읽어 곧바로 로그인 상태로 시작한다.)
function Gate() {
  const { user } = useAuth()
  if (user) return <><SessionWatcher /><Dashboard /></>
  return <AuthFlow />
}

export default function App() {
  return (
    // 맨 바깥 그물 (S15P11E101-897). 아래 구역 경계들이 못 잡는 자리 — 공급자·상단바·
    // 알림처럼 화면 밖에 있는 것들 — 에서 예외가 나도 백지 대신 안내와 '다시 시도' 를 남긴다.
    // 여기서 다시 마운트하면 AuthProvider 가 저장된 세션을 다시 읽으므로 로그인은 풀리지 않는다.
    <ErrorBoundary
      what="관제 화면"
      hint="예기치 못한 오류가 발생했습니다. 다시 시도를 누르면 화면을 다시 불러옵니다."
    >
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ErrorBoundary>
  )
}
