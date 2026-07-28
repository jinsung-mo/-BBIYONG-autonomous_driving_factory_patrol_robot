import { useState } from 'react'
import { useSim } from '../../SimContext.js'
import { useLive } from '../../live/LiveContext.jsx'
import { DRIVE_VECTORS } from '../../live/mappers.js'
import { cellToWorld } from '../../live/config.js'

const GOTO_OPTS = [
  { value: '4,0', label: '분전반 A' },
  { value: '11,4', label: '분전반 B' },
  { value: '7,7', label: '전기 판넬 C' },
  { value: '8,2', label: 'C구역 하역장 (CCTV)' },
]

// 순찰 로봇 수동 조작 패널 (WASD 이동 · 모드 · 지점이동)
//
// live 모드에서는 각 버튼이 /app/control/* 로 STOMP 발행한다(가이드 §4).
// - 방향키는 누르는 동안 DRIVE, 떼면 정지(0,0)를 보낸다.
// - '순찰 복귀'는 별도 명령이 없어 SET_MODE mode=autonomy 로 보낸다.
//
// 전조등·경고 방송·볼륨·리셋은 로봇 명령 계약에 없어(§5) 패널에서 제거했다.
export default function ControlPanel() {
  const { status, activeKeys, actions } = useSim()
  const { enabled, connected, control, telemetry } = useLive()
  const { switches } = status
  const [gotoVal, setGotoVal] = useState(GOTO_OPTS[0].value)

  // live 모드의 현재 모드는 시뮬이 아니라 텔레메트리가 정답이다
  // (발행은 성공해도 로봇이 모드를 바꾸지 못할 수 있으므로 서버 상태를 그대로 비춘다)
  const seg = enabled
    ? (telemetry?.status === 'MANUAL_CONTROL' ? 'manual' : 'patrol')
    : status.seg

  const liveReady = enabled && connected

  // 버튼은 키보드 방향키 기호로 표기 (조작은 WASD/방향키 동일)
  const glyph = { w: '△', a: '◁', s: '▽', d: '▷' }
  const key = (k) => {
    // live: 누르는 동안 주행, 떼면 정지 / mock: 기존처럼 클릭당 한 칸 이동
    const live = {
      onPointerDown: () => control.drive(DRIVE_VECTORS[k].linear, DRIVE_VECTORS[k].angular),
      onPointerUp: () => control.stop(),
      onPointerLeave: () => control.stop(),
    }
    return (
      <button
        className={activeKeys[k] ? 'active' : ''}
        aria-label={k}
        disabled={enabled && !connected}
        {...(enabled ? live : { onClick: () => actions.dpadMove(k) })}
      >
        {glyph[k]}
      </button>
    )
  }

  const Switch = ({ label, name }) => (
    <div className="sw">
      {label}
      <span
        className={`swb${switches[name] ? ' on' : ''}`}
        role="switch"
        aria-checked={switches[name]}
        tabIndex={0}
        onClick={() => actions.toggleSwitch(name)}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); actions.toggleSwitch(name) } }}
      >
        <i />
      </span>
    </div>
  )

  const onEmergencyStop = () => (liveReady ? control.estop() : actions.emergencyStop())
  const onReturnPatrol = () => (liveReady ? control.setMode('autonomy') : actions.returnPatrol())
  const onSetSeg = (man) => {
    if (liveReady) control.setMode(man ? 'manual' : 'autonomy')
    else actions.setSeg(man)
  }
  const onGoto = () => {
    const label = GOTO_OPTS.find((o) => o.value === gotoVal)?.label
    if (liveReady) {
      const [c, r] = gotoVal.split(',').map(Number)
      const { x, y } = cellToWorld(c, r)
      control.navigate(x, y, 0)
    } else {
      actions.goto(gotoVal, label)
    }
  }

  return (
    <div className="panel" id="pControl">
      <h3>
        순찰 로봇 수동 조작 패널 <span className="k">MANUAL CONTROL</span>
        {enabled && <span className="k" style={{ marginLeft: 8, color: connected ? '#3ddc97' : '#f5a623' }}>
          {connected ? 'LIVE' : 'DISCONNECTED'}
        </span>}
      </h3>
      <div className="ctl">
        <div className="col">
          <Switch label="로봇 제어" name="power" />
          <button className="dbtn stop" onClick={onEmergencyStop} disabled={enabled && !connected}>■ 긴급 정지</button>
          <button className="dbtn go" onClick={onReturnPatrol} disabled={enabled && !connected}>⇤ 순찰 복귀</button>
        </div>

        <div>
          {/* 실제 키보드 방향키(inverted-T): △ 위 / ◁ ▽ ▷ 아래 한 줄 */}
          <div className="dpad">
            <span />{key('w')}<span />
            {key('a')}{key('s')}{key('d')}
          </div>
          <div className="seg" style={{ marginTop: 12 }}>
            <button className={seg === 'patrol' ? 'on' : ''} onClick={() => onSetSeg(false)} disabled={enabled && !connected}>순찰 모드</button>
            <button className={seg === 'manual' ? 'on' : ''} onClick={() => onSetSeg(true)} disabled={enabled && !connected}>수동 모드</button>
          </div>
          <div className="gotor">
            <select value={gotoVal} onChange={(e) => setGotoVal(e.target.value)}>
              {GOTO_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button className="dbtn go" onClick={onGoto} disabled={enabled && !connected}>지점 이동</button>
          </div>
        </div>
      </div>
    </div>
  )
}
