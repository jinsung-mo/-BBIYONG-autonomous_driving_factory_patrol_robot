import { useEffect, useRef, useState } from 'react'
import { useSim } from '../../SimContext.js'
import { useLive } from '../../live/LiveContext.jsx'
import { DRIVE_VECTORS } from '../../live/mappers.js'
import { cellToWorld } from '../../live/config.js'

const GOTO_OPTS = [
  { value: '4,0', label: '분전반 A' },
  { value: '11,4', label: '분전반 B' },
  { value: '7,7', label: '분전반 C' },
]

// 순찰 로봇 수동 조작 패널 (WASD 이동 · 모드 · 지점이동)
//
// live 모드에서는 각 버튼이 /app/control/* 로 STOMP 발행한다(가이드 §4).
// - 방향키는 누르는 동안 DRIVE, 떼면 정지(0,0)를 보낸다.
// - '순찰 복귀'는 별도 명령이 없어 SET_MODE mode=autonomy 로 보낸다.
//
// 전조등·경고 방송·볼륨·리셋은 로봇 명령 계약에 없어(§5) 패널에서 제거했다.
//
// 단축키(S15P11E101-435): Shift 한 번 = 긴급 정지 ↔ 순찰 복귀 토글 · Space = 순찰 모드.
// ESTOP은 fail-safe라 해제 명령이 없고(가이드 §5) 해제는 SET_MODE autonomy 뿐이라,
// 두 동작을 한 키에 토글로 얹는 것이 프로토콜과 그대로 맞는다.
export default function ControlPanel() {
  const { status, activeKeys, actions } = useSim()
  const { enabled, connected, control, telemetry } = useLive()
  const { switches } = status
  const [gotoVal, setGotoVal] = useState(GOTO_OPTS[0].value)
  // mock 시뮬에는 estop 필드가 없고 모드 문구로만 표현되므로 패널이 직접 기억한다
  const [mockEstop, setMockEstop] = useState(false)

  // live 모드의 현재 모드는 시뮬이 아니라 텔레메트리가 정답이다
  // (발행은 성공해도 로봇이 모드를 바꾸지 못할 수 있으므로 서버 상태를 그대로 비춘다)
  const seg = enabled
    ? (telemetry?.status === 'MANUAL_CONTROL' ? 'manual' : 'patrol')
    : status.seg

  const liveReady = enabled && connected

  // E-STOP 체결 여부 — live는 텔레메트리가 정답, mock은 위 래치를 쓴다.
  // 텔레메트리가 아직 없으면(estop === undefined) 체결로 오해하지 않도록 명시적으로 검사한다.
  const estopEngaged = enabled
    ? (!!telemetry?.estop && telemetry.estop !== 'RELEASED')
    : mockEstop

  // 버튼은 키보드 키 이름으로 표기 (조작은 WASD/방향키 동일)
  const glyph = { w: 'W', a: 'A', s: 'S', d: 'D' }
  const dirLabel = { w: '전진', a: '좌회전', s: '후진', d: '우회전' }
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
        aria-label={`${dirLabel[k]} (${glyph[k]})`}
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

  const onEmergencyStop = () => {
    if (!enabled) setMockEstop(true)
    if (liveReady) control.estop()
    else actions.emergencyStop()
  }
  const onReturnPatrol = () => {
    if (!enabled) setMockEstop(false)
    if (liveReady) control.setMode('autonomy')
    else actions.returnPatrol()
  }
  const onSetSeg = (man) => {
    if (!enabled && !man) setMockEstop(false)
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

  // ---- 단축키 ----
  // 리스너는 enabled/connected 가 바뀔 때만 다시 걸고, 그때그때의 상태·핸들러는 ref로 읽는다
  // (핸들러가 매 렌더 새로 만들어지므로 의존성에 넣으면 리스너를 계속 재등록하게 된다).
  const latest = useRef(null)
  latest.current = { estopEngaged, onEmergencyStop, onReturnPatrol, onSetSeg }

  useEffect(() => {
    if (enabled && !connected) return undefined // 버튼 disabled 와 같은 게이트

    // Shift 단독 탭만 단축키로 인정한다. keydown 시점에 실행하면 Shift+A 같은
    // 조합키를 누르는 순간에도 긴급 정지가 나가버리므로, 사이에 다른 키가 없었을 때만 keyup에서 실행한다.
    let shiftAlone = false
    const isTyping = (el) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)

    const onDown = (e) => {
      if (e.key === 'Shift') { if (!e.repeat && !isTyping(e.target)) shiftAlone = true; return }
      shiftAlone = false
      if (e.code !== 'Space') return
      if (isTyping(e.target)) return
      // 포커스된 버튼의 기본 활성화(=중복 실행)와 페이지 스크롤을 막는다
      e.preventDefault()
      if (e.repeat) return
      latest.current.onSetSeg(false)
    }
    const onUp = (e) => {
      if (e.key !== 'Shift') return
      if (!shiftAlone) return
      shiftAlone = false
      if (isTyping(e.target)) return
      const s = latest.current
      if (s.estopEngaged) s.onReturnPatrol()
      else s.onEmergencyStop()
    }
    const onBlur = () => { shiftAlone = false }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled, connected])

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
          {/* Shift 뱃지는 지금 그 키가 실행할 버튼에만 붙인다 — 어느 쪽으로 토글되는지 화면으로 알 수 있게 */}
          <button
            className="dbtn stop keyed"
            onClick={onEmergencyStop}
            disabled={enabled && !connected}
            aria-keyshortcuts={estopEngaged ? undefined : 'Shift'}
          >
            <span>■ 긴급 정지</span>
            {!estopEngaged && <kbd className="kbd">Shift</kbd>}
          </button>
          <button
            className="dbtn go keyed"
            onClick={onReturnPatrol}
            disabled={enabled && !connected}
            aria-keyshortcuts={estopEngaged ? 'Shift' : undefined}
          >
            <span>⇤ 순찰 복귀</span>
            {estopEngaged && <kbd className="kbd">Shift</kbd>}
          </button>
        </div>

        <div>
          {/* 실제 키보드 방향키(inverted-T): △ 위 / ◁ ▽ ▷ 아래 한 줄 */}
          <div className="dpad">
            <span />{key('w')}<span />
            {key('a')}{key('s')}{key('d')}
          </div>
          <div className="seg" style={{ marginTop: 12 }}>
            <button
              className={seg === 'patrol' ? 'on' : ''}
              onClick={() => onSetSeg(false)}
              disabled={enabled && !connected}
              aria-keyshortcuts="Space"
            >
              순찰 모드
              <kbd className="kbd">Space</kbd>
            </button>
            <button className={seg === 'manual' ? 'on' : ''} onClick={() => onSetSeg(true)} disabled={enabled && !connected}>
              수동 모드
              {/* 단축키가 아니라 조작 안내 — 수동 모드에서 무엇으로 움직이는지 알려준다 */}
              <kbd className="kbd">WASD · 방향키</kbd>
            </button>
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
