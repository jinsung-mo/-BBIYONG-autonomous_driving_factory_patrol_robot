import { useEffect } from 'react'
import { useSim } from '../../SimContext.ts'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import KpiRow from './KpiRow.tsx'
import StatusPanel from './StatusPanel.tsx'
import EventLog from './EventLog.tsx'
import MapPanel from './MapPanel.tsx'

// 지도 화면 (시뮬레이션 전용).
//
// 관제를 지도와 카메라 두 화면으로 나눈 첫 화면이다. 지도는 구역 전체를 봐야 하는
// 물건이라 넓게 둔다. 좌측에는 '지금 로봇이 어떤 상태인가' 와 '무슨 일이 있었나' —
// 지도를 보면서 곁눈으로 확인할 것들만 남긴다.
//
// 조작(수동 주행·모드 전환)은 카메라 화면에 있다. 눈으로 보면서 몰아야 하는 일이라
// 영상 옆에 있는 편이 맞다.
export default function MapPage() {
  const { actions } = useSim()
  const { settings } = useSettings()
  const { telemetry, enabled } = useLive()

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

      <div className="nav-stage">
        {/* 카드 두 장(S15P11E101-797). 로봇 상태와 이벤트 로그는 성격이 다른 정보다 —
            한 장에 있으면 어디까지가 한 덩어리인지 읽히지 않는다. */}
        <aside className="nav-side" aria-label="로봇 상태와 이벤트">
          <StatusPanel />
          <EventLog />
        </aside>
        <div className={`nav-canvas${mapDown ? ' down' : ''}`}>
          <MapPanel />
        </div>
      </div>
    </section>
  )
}
