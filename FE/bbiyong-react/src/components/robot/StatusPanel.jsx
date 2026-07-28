import { useSim } from '../../SimContext.js'
import { useLive } from '../../live/LiveContext.jsx'
import { telemetryToStatus } from '../../live/mappers.js'
import LogList from '../LogList.jsx'

// 순찰 로봇 상태 + 환경 + 이벤트 로그
// live 모드에서는 /topic/robots 텔레메트리를 그대로 표시한다.
// 주변 온도·습도는 로봇에 센서가 없어 텔레메트리에 없다(가이드 §3.1) → live 모드에서 숨긴다.
export default function StatusPanel() {
  const { status } = useSim()
  const { enabled, connected, telemetry, robotId } = useLive()

  const live = enabled ? telemetryToStatus(telemetry) : null
  const modeText = live ? live.modeText : status.modeText
  const modeClass = live ? live.modeClass : status.modeClass
  const batt = live ? live.batt : status.batt
  const spd = live ? live.spd : status.spd
  const estop = live ? live.estop : 'RELEASED'
  const comm = live ? live.comm : '양호 · 43ms'
  const fps = live ? live.fps : '8.0'
  const name = enabled ? robotId : '오린카-01'

  const okColor = { color: 'var(--dk-green)' }

  return (
    <div className="panel" id="pStatus">
      <h3>순찰 로봇 상태 <span className="k">ORINCA FLEET</span></h3>
      <div className="stat-card">
        <div className="rid">🤖 {name} <span className={`pillm ${modeClass}`}>{modeText}</span></div>
        <div className="kv"><span>배터리</span><b className="mono">{batt == null ? '—' : `${batt}%`}</b></div>
        <div className="bar"><i style={{ width: `${batt ?? 0}%` }} /></div>
        <div className="kv"><span>속도</span><b className="mono">{spd}</b></div>
        <div className="kv"><span>E-STOP</span><b style={estop === 'RELEASED' ? okColor : undefined}>{estop}</b></div>
        <div className="kv"><span>통신 감도</span><b style={live && !connected ? undefined : okColor}>{comm}</b></div>
        <div className="kv"><span>추론 FPS</span><b className="mono">{fps}</b></div>
        {live?.location && (
          // 미터 단위 원시 좌표 — 지도 격자 변환과 무관하게 서버 값 그대로 확인할 수 있도록 노출
          <div className="kv"><span>위치 (m)</span><b className="mono">
            {live.location.x?.toFixed(2)}, {live.location.y?.toFixed(2)}
          </b></div>
        )}
      </div>
      {!enabled && (
        <div className="env">
          <div><b className="mono">{status.envT}</b><span>주변 온도</span></div>
          <div><b className="mono">{status.envH}</b><span>습도</span></div>
        </div>
      )}
      <h3 style={{ marginTop: 12 }}>이벤트 로그</h3>
      <LogList variant="elog" />
    </div>
  )
}
