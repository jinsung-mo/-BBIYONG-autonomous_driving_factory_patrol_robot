import { useSim } from '../../SimContext.ts'
import { displayName } from '../../live/robotName.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { telemetryToStatus } from '../../live/mappers.ts'
import RadialGauge from './RadialGauge.tsx'

// 순찰 로봇 상태
// live 모드에서는 /topic/robots 텔레메트리를 그대로 표시한다.
// 위치(좌표/구역)·통신 감도 표시는 제거했다(S15P11E101 콘솔 정리) — 위치는 지도 캔버스가,
// 연결 상태는 조작 패널 헤더의 LIVE/DISCONNECTED 가 더 정확히 보여 준다.
export default function StatusPanel() {
  const { status } = useSim()
  const { enabled, connected, telemetry, robotId } = useLive()

  const live = enabled ? telemetryToStatus(telemetry) : null
  // 연결이 끊겼을 때만 '연결 대기'로 말한다. 연결돼 있는데 status 만 없는 경우는 매퍼의 '대기'를 쓴다.
  const modeText = live ? (connected ? live.modeText : '연결 대기') : status.modeText
  const modeClass = live ? live.modeClass : status.modeClass
  const batt = live ? live.batt : status.batt
  // 화면에는 표시명을 쓴다(S15P11E101-766). 통신·구독은 계약 id 그대로다.
  const name = enabled ? displayName(robotId) : '삐용'

  return (
    <div className="panel" id="pStatus">
      <h3>순찰 로봇 상태 <span className="k">ORINCA FLEET</span></h3>
      <div className="stat-card">
        <div className="rid">{name} <span className={`pillm ${modeClass}`}>{modeText}</span></div>
        {/* 시뮬레이션 화면에서는 배터리를 대표 지표로 세운다 — 막대보다 멀리서 읽힌다.
            실서버 화면은 기존 표기를 그대로 둔다. */}
        {enabled ? (
          <>
            <div className="kv"><span>배터리</span><b className="num">{batt == null ? '—' : `${batt} %`}</b></div>
            <div className="bar"><i style={{ width: `${batt ?? 0}%` }} /></div>
          </>
        ) : (
          <RadialGauge value={batt} label="배터리" caption="BATTERY" />
        )}
      </div>
    </div>
  )
}
