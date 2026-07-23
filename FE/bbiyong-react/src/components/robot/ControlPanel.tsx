import { useState } from 'react'
import { useSim } from '../../SimContext'
import type { KeyName, SwitchName } from '../../types'

const GOTO_OPTS = [
  { value: '4,0', label: '분전반 A' },
  { value: '11,4', label: '분전반 B' },
  { value: '7,7', label: '전기 판넬 C' },
  { value: '8,2', label: 'C구역 하역장 (CCTV)' },
]

// 순찰 로봇 수동 조작 패널 (WASD 이동 · 모드 · 지점이동 · 토글)
export default function ControlPanel() {
  const { status, activeKeys, actions } = useSim()
  const { seg, switches } = status
  const [gotoVal, setGotoVal] = useState(GOTO_OPTS[0].value)

  // 버튼은 키보드 방향키 기호로 표기 (조작은 WASD/방향키 동일)
  const glyph: Record<KeyName, string> = { w: '△', a: '◁', s: '▽', d: '▷' }
  const key = (k: KeyName) => (
    <button
      className={activeKeys[k] ? 'active' : ''}
      aria-label={k}
      onClick={() => actions.dpadMove(k)}
    >
      {glyph[k]}
    </button>
  )

  const Switch = ({ label, name }: { label: string; name: SwitchName }) => (
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

  return (
    <div className="panel" id="pControl">
      <h3>순찰 로봇 수동 조작 패널 <span className="k">MANUAL CONTROL</span></h3>
      <div className="ctl">
        <div className="col">
          <Switch label="로봇 제어" name="power" />
          <button className="dbtn stop" onClick={actions.emergencyStop}>■ 긴급 정지</button>
          <button className="dbtn" onClick={actions.reset}>↺ 리셋</button>
          <button className="dbtn go" onClick={actions.returnPatrol}>⇤ 순찰 복귀</button>
        </div>

        <div>
          {/* 실제 키보드 방향키(inverted-T): △ 위 / ◁ ▽ ▷ 아래 한 줄 */}
          <div className="dpad">
            <span />{key('w')}<span />
            {key('a')}{key('s')}{key('d')}
          </div>
          <div className="seg" style={{ marginTop: 12 }}>
            <button className={seg === 'patrol' ? 'on' : ''} onClick={() => actions.setSeg(false)}>순찰 모드</button>
            <button className={seg === 'manual' ? 'on' : ''} onClick={() => actions.setSeg(true)}>수동 모드</button>
          </div>
          <div className="gotor">
            <select value={gotoVal} onChange={(e) => setGotoVal(e.target.value)}>
              {GOTO_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              className="dbtn go"
              onClick={() => actions.goto(gotoVal, GOTO_OPTS.find((o) => o.value === gotoVal)?.label)}
            >
              지점 이동
            </button>
          </div>
        </div>

        <div className="col">
          <Switch label="전조등" name="light" />
          <Switch label="경고 방송" name="siren" />
          <div className="kv" style={{ marginTop: 6 }}><span>볼륨</span><b className="mono">100</b></div>
          <input type="range" min="0" max="100" defaultValue="100" aria-label="볼륨" />
        </div>
      </div>
    </div>
  )
}
