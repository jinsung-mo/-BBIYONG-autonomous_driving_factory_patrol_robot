import { useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import KpiRow from './KpiRow.tsx'
import StatusPanel from './StatusPanel.tsx'
import EventLog from './EventLog.tsx'
import MapPanel from './MapPanel.tsx'
import MappingTab from './MappingTab.tsx'

// 지도 화면.
//
// 좌측에는 '지금 로봇이 어떤 상태인가' 와 '무슨 일이 있었나' — 지도를 보면서 곁눈으로
// 확인할 것들만 남긴다. 조작(수동 주행·모드 전환)은 카메라 화면에 있다.
//
// '매핑' 탭(S15P11E101 콘솔 정리): 운영 탭에 있던 2D 맵 모델링 + 순찰 경로를 이리로 옮겼다.
// 맵을 그리는 관리자 작업이라 관리자에게만 보인다.
export default function MapPage() {
  const { actions } = useSim()
  const { settings } = useSettings()
  const { telemetry, enabled } = useLive()
  const { isAdmin } = useAuth()
  const [tab, setTab] = useState<'map' | 'mapping'>('map')

  // 열화상 경고·임계 기준을 설정 값으로 맞춘다(S15P11E101-475 설정 탭)
  useEffect(() => {
    actions.setTempThresholds(settings.tempWarn, settings.tempCritical)
  }, [actions, settings.tempWarn, settings.tempCritical])

  const mapDown = enabled && isDown(capOf(telemetry, CAP_KEYS.map))

  return (
    <section id="pgMap" className="page on sim-skin nav-page v3-theme">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>순찰 구역</h2>
          <span className="nav-sub">ORINCA FLEET</span>
        </div>
        <KpiRow />
      </div>

      {/* 지도 / 매핑 전환 탭(S15P11E101 콘솔 정리). 매핑은 관리자 전용. */}
      {isAdmin && (
        <div className="map-tabs seg" role="tablist" aria-label="지도 또는 매핑">
          <button type="button" role="tab" aria-selected={tab === 'map'} className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>지도</button>
          <button type="button" role="tab" aria-selected={tab === 'mapping'} className={tab === 'mapping' ? 'on' : ''} onClick={() => setTab('mapping')}>매핑</button>
        </div>
      )}

      {/* 지도 화면은 계속 마운트해 둔다(hidden) — 탭을 옮겼다고 캔버스와 STOMP 구독을 버리면
          돌아올 때마다 지도가 처음부터 다시 붙는다. */}
      <div hidden={isAdmin && tab === 'mapping'}>
        <div className="nav-stage">
          {/* 카드 두 장(S15P11E101-797). 로봇 상태와 이벤트 로그는 성격이 다른 정보다. */}
          <aside className="nav-side" aria-label="로봇 상태와 이벤트">
            <StatusPanel />
            <EventLog />
          </aside>
          <div className={`nav-canvas${mapDown ? ' down' : ''}`}>
            <MapPanel />
          </div>
        </div>
      </div>

      {isAdmin && tab === 'mapping' && <MappingTab />}
    </section>
  )
}
