import { useEffect, useRef, useState } from 'react'
import { useSim } from '../../SimContext.js'
import { useLive } from '../../live/LiveContext.jsx'
import {
  DRIVE_VECTORS, DRIVE_SPEED_MIN, DRIVE_SPEED_MAX, DRIVE_SPEED_STEP, clampDriveSpeed,
} from '../../live/mappers.js'
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
  const { enabled, connected, control, telemetry, speed, setSpeed } = useLive()
  const [gotoVal, setGotoVal] = useState(GOTO_OPTS[0].value)

  // 모드 토글은 '사용자가 고른 제어 모드'다 — 버튼을 누를 때만 바뀐다.
  //
  // 예전에는 telemetry.status 로 매 텔레메트리마다 다시 계산했는데, 로봇 브리지의 status 는
  // 움직임 기준(움직이면 MANUAL_CONTROL, 멈추면 AUTO_PATROL)이라 WASD 를 떼는 순간
  // 토글이 '순찰'로 튀어 돌아갔다. 로봇의 현재 상태는 상태 패널 pill 이 따로 보여주므로,
  // 토글과 status 는 별개 축으로 둔다.
  const [seg, setSeg] = useState('patrol')

  const liveReady = enabled && connected

  // E-STOP 체결 여부 — live는 텔레메트리가, mock은 시뮬 상태가 정답이다.
  // 텔레메트리가 아직 없으면(estop === undefined) 체결로 오해하지 않도록 명시적으로 검사한다.
  const estopEngaged = enabled
    ? (!!telemetry?.estop && telemetry.estop !== 'RELEASED')
    : status.estop !== 'RELEASED'

  // 주행을 시작하는 것도 사용자가 수동 조작을 고른 행위다 — 토글을 수동으로 맞춘다.
  // 표시만 바꾸고 SET_MODE 는 보내지 않는다(모드 전환은 모드 버튼의 몫).
  // 키를 떼거나 텔레메트리가 바뀌는 것으로는 되돌아가지 않는다(S15P11E101-448).
  const markManual = () => setSeg('manual')

  // 버튼은 키보드 키 이름으로 표기 (조작은 WASD/방향키 동일)
  const glyph = { w: 'W', a: 'A', s: 'S', d: 'D' }
  const dirLabel = { w: '전진', a: '좌회전', s: '후진', d: '우회전' }
  const key = (k) => {
    // live: 누르는 동안 주행, 떼면 정지 / mock: 기존처럼 클릭당 한 칸 이동
    const live = {
      onPointerDown: () => {
        markManual()
        control.drive(DRIVE_VECTORS[k].linear, DRIVE_VECTORS[k].angular)
      },
      onPointerUp: () => control.stop(),
      onPointerLeave: () => control.stop(),
    }
    return (
      <button
        className={activeKeys[k] ? 'active' : ''}
        aria-label={`${dirLabel[k]} (${glyph[k]})`}
        disabled={enabled && !connected}
        {...(enabled ? live : { onClick: () => { markManual(); actions.dpadMove(k) } })}
      >
        {glyph[k]}
      </button>
    )
  }

  // mock 경로의 E-STOP 체결/해제는 Simulation 이 직접 관리한다(emergencyStop / botResume).
  const onEmergencyStop = () => {
    if (liveReady) control.estop()
    else actions.emergencyStop()
  }
  const onReturnPatrol = () => {
    // 순찰 복귀도 SET_MODE autonomy 를 보내므로 '순찰 모드'를 고른 것과 같다 — 토글도 함께 맞춘다
    setSeg('patrol')
    if (liveReady) control.setMode('autonomy')
    else actions.returnPatrol()
  }
  const onSetSeg = (man) => {
    setSeg(man ? 'manual' : 'patrol')
    if (liveReady) control.setMode(man ? 'manual' : 'autonomy')
    else actions.setSeg(man)
  }
  // 속도는 live(발행 배율)와 mock(표시 속도) 양쪽에 함께 반영한다 — 어느 모드에서도 죽은 버튼이 되지 않게
  const onSetSpeed = (v) => {
    const next = clampDriveSpeed(v)
    setSpeed(next)
    actions.setManualSpeed(next)
  }
  const speedPct = ((speed - DRIVE_SPEED_MIN) / (DRIVE_SPEED_MAX - DRIVE_SPEED_MIN)) * 100

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
  latest.current = { estopEngaged, seg, onEmergencyStop, onReturnPatrol, onSetSeg, markManual }

  useEffect(() => {
    if (enabled && !connected) return undefined // 버튼 disabled 와 같은 게이트

    // Shift 단독 탭만 단축키로 인정한다. keydown 시점에 실행하면 Shift+A 같은
    // 조합키를 누르는 순간에도 긴급 정지가 나가버리므로, 사이에 다른 키가 없었을 때만 keyup에서 실행한다.
    let shiftAlone = false
    const isTyping = (el) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
    // 주행 키 — 방향키도 WASD 와 같은 조작이다(useSimulation · LiveSimBridge 의 매핑과 동일)
    const DRIVE_KEYS = /^([wasd]|arrow(up|down|left|right))$/

    const onDown = (e) => {
      if (e.key === 'Shift') { if (!e.repeat && !isTyping(e.target)) shiftAlone = true; return }
      shiftAlone = false
      if (DRIVE_KEYS.test(e.key.toLowerCase())) {
        if (!isTyping(e.target)) latest.current.markManual()
        return
      }
      if (e.code !== 'Space') return
      if (isTyping(e.target)) return
      // 포커스된 버튼의 기본 활성화(=중복 실행)와 페이지 스크롤을 막는다
      e.preventDefault()
      if (e.repeat) return
      // 순찰 ↔ 수동 토글 — Shift(긴급 정지 ↔ 순찰 복귀)와 같은 규칙
      latest.current.onSetSeg(latest.current.seg !== 'manual')
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
        {/* 비상·복구 조작은 이동 조작(방향 버튼·모드·지점 이동)과 떼어 놓는다 — 조작 중 오클릭 방지 */}
        <div className="col">
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

          {/* 주행 속도 — 방향 단위벡터에 이 값을 곱해 발행한다 */}
          <div className="spd">
            <div className="spdlab">
              <span>주행 속도</span><b className="mono">{speed.toFixed(2)} m/s</b>
            </div>
            <div className="spdr">
              <button
                className="dbtn"
                onClick={() => onSetSpeed(speed - DRIVE_SPEED_STEP)}
                disabled={(enabled && !connected) || speed <= DRIVE_SPEED_MIN}
                aria-label="주행 속도 낮추기"
              >
                −
              </button>
              <div
                className="spdbar"
                role="slider"
                aria-label="주행 속도"
                aria-valuemin={DRIVE_SPEED_MIN}
                aria-valuemax={DRIVE_SPEED_MAX}
                aria-valuenow={speed}
                aria-valuetext={`${speed.toFixed(2)} m/s`}
              >
                <i style={{ width: `${speedPct}%` }} />
              </div>
              <button
                className="dbtn"
                onClick={() => onSetSpeed(speed + DRIVE_SPEED_STEP)}
                disabled={(enabled && !connected) || speed >= DRIVE_SPEED_MAX}
                aria-label="주행 속도 높이기"
              >
                +
              </button>
            </div>
          </div>
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
              aria-keyshortcuts={seg === 'manual' ? 'Space' : undefined}
            >
              순찰 모드
              {/* Space 뱃지는 지금 그 키가 전환할 대상 버튼에만 붙인다 (Shift 뱃지와 같은 규칙) */}
              {seg === 'manual' && <kbd className="kbd">Space</kbd>}
            </button>
            <button
              className={seg === 'manual' ? 'on' : ''}
              onClick={() => onSetSeg(true)}
              disabled={enabled && !connected}
              aria-keyshortcuts={seg === 'patrol' ? 'Space' : undefined}
            >
              수동 모드
              {seg === 'patrol' && <kbd className="kbd">Space</kbd>}
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
