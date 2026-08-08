import { useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import KpiRow from './KpiRow.tsx'
import StatusPanel from './StatusPanel.tsx'
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
          {/* 🔴 이벤트 로그 카드를 뗐다(S15P11E101-867). 이벤트는 전용 탭이 따로 있고
              거기서 필터·기간 조회·상세·영상까지 준다. 여기 있던 건 최근 몇 줄만 보여 주는
              축약본이라, 같은 정보를 두 곳에서 다르게 보여 주고 있었다.
              지도 화면이 답할 질문은 "지금 어디서 무슨 일이 벌어지는가" 이고, 그건 지도 위
              마커와 상단 KPI(경보 이벤트 오늘 N건)가 이미 답한다 — 지나간 것을 조사하는 일은
              이벤트 탭의 몫이다. 디자인 시스템 원본의 지도 화면에도 로그 카드가 없다.
              ⚠ `EventLog.tsx` 파일 자체는 지우지 않는다 — 카메라 화면이 계속 쓴다. */}
          <aside className="nav-side" aria-label="로봇 상태">
            <StatusPanel />
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
