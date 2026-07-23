import { useSim } from '../../SimContext'
import LogList from '../LogList'

// 순찰 로봇 상태 + 환경 + 이벤트 로그
export default function StatusPanel() {
  const { status } = useSim()
  const { modeText, modeClass, batt, spd, envT, envH } = status
  return (
    <div className="panel" id="pStatus">
      <h3>순찰 로봇 상태 <span className="k">ORINCA FLEET</span></h3>
      <div className="stat-card">
        <div className="rid">🤖 오린카-01 <span className={`pillm ${modeClass}`}>{modeText}</span></div>
        <div className="kv"><span>배터리</span><b className="mono">{batt}%</b></div>
        <div className="bar"><i style={{ width: `${batt}%` }} /></div>
        <div className="kv"><span>속도</span><b className="mono">{spd}</b></div>
        <div className="kv"><span>E-STOP</span><b style={{ color: 'var(--dk-green)' }}>RELEASED</b></div>
        <div className="kv"><span>통신 감도</span><b style={{ color: 'var(--dk-green)' }}>양호 · 43ms</b></div>
        <div className="kv"><span>추론 FPS</span><b className="mono">8.0</b></div>
      </div>
      <div className="env">
        <div><b className="mono">{envT}</b><span>주변 온도</span></div>
        <div><b className="mono">{envH}</b><span>습도</span></div>
      </div>
      <h3 style={{ marginTop: 12 }}>이벤트 로그</h3>
      <LogList variant="elog" />
    </div>
  )
}
