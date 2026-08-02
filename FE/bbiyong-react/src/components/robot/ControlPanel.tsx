import { useEffect, useRef, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { DRIVE_VECTORS, speedParams, clampDriveSpeed } from '../../live/mappers.ts'
import { worldToCell } from '../../live/config.ts'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import CapBadge from './CapBadge.tsx'
import CameraTilt from './CameraTilt.tsx'

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
// 순찰 복귀를 보낸 뒤 로봇이 E-STOP 을 풀 때까지 기다리는 시간.
// 텔레메트리는 1Hz 라 두세 주기는 봐야 '처리하지 않았다'고 말할 수 있다.
const RESUME_WAIT_MS = 4000

export default function ControlPanel() {
  const { status, activeKeys, actions } = useSim()
  const {
    enabled, connected, control, telemetry, speed, setSpeed, robotOnline,
    driveMode: seg, setDriveMode: setSeg,
  } = useLive()
  const { settings } = useSettings()
  const { isAdmin } = useAuth()
  // 순찰 지점은 설정 탭에서 등록/편집한다(S15P11E101-475). 관제에서는 실행만 한다.
  const points = settings.points
  const [gotoId, setGotoId] = useState(points[0]?.id)
  // 조작 결과 안내 — 명령이 조용히 버려지는 경우를 알린다(S15P11E101-595)
  const [ctlMsg, setCtlMsg] = useState<{ kind: string, text: string } | null>(null)
  const resumeTimer = useRef<any>(null)
  const goal = points.find((p: any) => p.id === gotoId) || points[0]
  const spd = speedParams(settings.vMax)

  // 모드 토글은 '사용자가 고른 제어 모드'다 — 버튼을 누를 때만 바뀐다.
  //
  // 예전에는 telemetry.status 로 매 텔레메트리마다 다시 계산했는데, 로봇 브리지의 status 는
  // 움직임 기준(움직이면 MANUAL_CONTROL, 멈추면 AUTO_PATROL)이라 WASD 를 떼는 순간
  // 토글이 '순찰'로 튀어 돌아갔다. 로봇의 현재 상태는 상태 패널 pill 이 따로 보여주므로,
  // 토글과 status 는 별개 축으로 둔다.
  // 값 자체는 LiveContext 가 들고 있다 — 키보드 주행을 발행하는 LiveSimBridge 도 봐야 한다(S15P11E101-513).

  const liveReady = enabled && connected
  // 서버에는 붙었지만 로봇 세션이 없으면 BE 가 로그만 남기고 버린다(RobotControlStompController.relay).
  // FE 로는 아무 응답이 오지 않으므로, 보낸 쪽에서 그 사실을 말해 주지 않으면 조작자는 먹은 줄 안다.
  const robotOffline = enabled && connected && robotOnline === false

  // 연결 배지 3단계. '서버에 붙었다'와 '로봇이 켜져 있다'를 한 문구로 뭉뚱그리면,
  // 로봇이 꺼진 밤에도 LIVE 로 보여 조작자가 명령이 먹힌다고 오해한다.
  const linkText = !connected ? 'DISCONNECTED' : (robotOnline === false ? '로봇 오프라인' : 'LIVE')
  const linkColor = !connected ? '#f5a623' : (robotOnline === false ? '#f5a623' : '#3ddc97')

  // 로봇 주행 노드가 죽어 있으면 조작을 막는다 — 받을 쪽이 없는데 DRIVE 를 쏘면
  // 화면만 반응하고 로봇은 그대로라 조작자가 오해한다(S15P11E101-462).
  const driveDown = enabled && isDown(capOf(telemetry, CAP_KEYS.drive))
  // 뷰어는 조작할 수 없다 — 버튼을 숨기지 않고 회색으로 남겨 '권한 없음'이 드러나게 한다.
  const ctlOff = (enabled && !connected) || driveDown || !isAdmin
  // 안전 예외: 긴급 정지는 권한과 무관하게 로그인만 하면 누구나 즉시 누를 수 있어야 한다.
  const estopOff = (enabled && !connected) || driveDown

  // E-STOP 체결 여부 — live는 텔레메트리가, mock은 시뮬 상태가 정답이다.
  // 텔레메트리가 아직 없으면(estop === undefined) 체결로 오해하지 않도록 명시적으로 검사한다.
  const estopEngaged = enabled
    ? (!!telemetry?.estop && telemetry.estop !== 'RELEASED')
    : status.estop !== 'RELEASED'

  // 주행 입력은 모드를 바꾸지 않는다(S15P11E101-513). 예전에는 WASD 를 누르면 토글이
  // 수동으로 넘어갔는데, 순찰 중 화면을 잠깐 건드린 것만으로 순찰이 멈추는 셈이었다.
  // 모드 전환은 스페이스바와 모드 버튼만 한다.
  const manual = seg === 'manual'

  // 버튼은 키보드 키 이름으로 표기 (조작은 WASD/방향키 동일)
  const glyph: Record<string, string> = { w: 'W', a: 'A', s: 'S', d: 'D' }
  const dirLabel: Record<string, string> = { w: '전진', a: '좌회전', s: '후진', d: '우회전' }
  const key = (k: any) => {
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
        // 순찰 중에는 주행 명령이 무효다 — 눌러도 아무 일이 없는 버튼으로 두지 않고 잠근다
        disabled={ctlOff || !manual}
        title={!manual ? '수동 모드에서 조작할 수 있습니다 (Space)' : undefined}
        {...(enabled ? live : { onClick: () => actions.dpadMove(k) })}
      >
        {glyph[k]}
      </button>
    )
  }

  // mock 경로의 E-STOP 체결/해제는 Simulation 이 직접 관리한다(emergencyStop / botResume).
  // 로봇이 없으면 명령은 서버에서 버려진다 — 누른 사람에게 그대로 말한다
  const warnIfOffline = () => {
    if (!robotOffline) return false
    setCtlMsg({ kind: 'warn', text: '로봇이 오프라인입니다 — 명령이 로봇에 전달되지 않았습니다.' })
    return true
  }

  const onEmergencyStop = () => {
    if (liveReady) { control.estop(); if (!warnIfOffline()) setCtlMsg(null) }
    else actions.emergencyStop()
  }
  const onReturnPatrol = () => {
    // 순찰 복귀도 SET_MODE autonomy 를 보내므로 '순찰 모드'를 고른 것과 같다 — 토글도 함께 맞춘다
    setSeg('patrol')
    if (!liveReady) { actions.returnPatrol(); return }
    control.setMode('autonomy')
    if (warnIfOffline()) return
    setCtlMsg(null)
    // 로봇이 SET_MODE 를 아직 처리하지 않으면(cloud_bridge.translate_command 가 noop 으로 버린다)
    // E-STOP 이 풀리지 않는다. 화면 토글만 '순찰'로 바뀐 채 실제로는 체결 상태로 남아 조작자를 속인다.
    // 잠시 기다렸다가 그대로면 사실대로 알린다 — 해제되면 아래 effect 가 이 안내를 지운다.
    if (estopEngaged) {
      clearTimeout(resumeTimer.current)
      resumeTimer.current = setTimeout(() => {
        if (latest.current.estopEngaged) {
          setCtlMsg({ kind: 'err', text: '로봇이 순찰 복귀를 처리하지 않았습니다 — E-STOP 이 여전히 체결 상태입니다.' })
        }
      }, RESUME_WAIT_MS)
    }
  }
  const onSetSeg = (man: any) => {
    setSeg(man ? 'manual' : 'patrol')
    if (liveReady) { control.setMode(man ? 'manual' : 'autonomy'); warnIfOffline() }
    else actions.setSeg(man)
  }
  // 속도는 live(발행 배율)와 mock(표시 속도) 양쪽에 함께 반영한다 — 어느 모드에서도 죽은 버튼이 되지 않게
  const onSetSpeed = (v: any) => {
    const next = clampDriveSpeed(v, settings.vMax)
    setSpeed(next)
    actions.setManualSpeed(next)
  }
  const speedPct = ((speed - spd.min) / (spd.max - spd.min)) * 100

  const onGoto = () => {
    if (!goal) return
    // 저장값은 미터(map 프레임)다. 실서버는 그대로 보내고, 시뮬은 격자로 환산해 넘긴다.
    if (liveReady) { control.navigate(goal.x, goal.y, 0); warnIfOffline() }
    else {
      const { c, r } = worldToCell(goal.x, goal.y)
      actions.goto(`${c},${r}`, goal.label)
    }
  }

  // ---- 단축키 ----
  // 리스너는 enabled/connected 가 바뀔 때만 다시 걸고, 그때그때의 상태·핸들러는 ref로 읽는다
  // (핸들러가 매 렌더 새로 만들어지므로 의존성에 넣으면 리스너를 계속 재등록하게 된다).
  const latest = useRef<any>(null)
  latest.current = { estopEngaged, seg, ctlOff, onEmergencyStop, onReturnPatrol, onSetSeg }

  // E-STOP 이 실제로 풀리면 경고를 지운다 — 해결된 안내가 남아 있으면 다음 판단을 흐린다.
  useEffect(() => {
    if (estopEngaged) return
    clearTimeout(resumeTimer.current)
    setCtlMsg((m) => (m?.kind === 'err' ? null : m))
  }, [estopEngaged])
  useEffect(() => () => clearTimeout(resumeTimer.current), [])

  useEffect(() => {
    // 게이트는 버튼과 같은 규칙을 쓴다(S15P11E101-595).
    // 긴급 정지는 estopOff(권한 무관 안전 예외), 나머지는 ctlOff 다.
    // 예전에는 리스너 전체를 ctlOff 로 막아, 버튼은 눌리는데 Shift 만 죽는 뷰어가 생겼다.
    if (estopOff) return undefined

    // Shift 단독 탭만 단축키로 인정한다. keydown 시점에 실행하면 Shift+A 같은
    // 조합키를 누르는 순간에도 긴급 정지가 나가버리므로, 사이에 다른 키가 없었을 때만 keyup에서 실행한다.
    let shiftAlone = false
    // 글자를 입력하는 요소에서만 막는다. select 는 Shift 로 글자가 들어가지 않으므로
    // 지점 이동 드롭다운을 건드렸다는 이유로 긴급 정지가 죽어서는 안 된다(S15P11E101-595).
    const isTyping = (el: any) => {
      if (!el) return false
      if (el.isContentEditable) return true
      if (el.tagName === 'TEXTAREA') return true
      if (el.tagName !== 'INPUT') return false
      // 체크박스·라디오·버튼형 input 은 글자를 받지 않는다
      return !/^(checkbox|radio|button|submit|reset|range|color)$/i.test(el.type || 'text')
    }
    // 주행 키 — 방향키도 WASD 와 같은 조작이다(useSimulation · LiveSimBridge 의 매핑과 동일)
    const DRIVE_KEYS = /^([wasd]|arrow(up|down|left|right))$/

    const onDown = (e: any) => {
      if (e.key === 'Shift') { if (!e.repeat && !isTyping(e.target)) shiftAlone = true; return }
      shiftAlone = false
      // 주행 키는 모드를 건드리지 않는다(S15P11E101-513). 실제 주행 발행은
      // live 는 LiveSimBridge, mock 은 useSimulation 의 키 리스너가 맡는다.
      if (DRIVE_KEYS.test(e.key.toLowerCase())) return
      if (e.code !== 'Space') return
      if (isTyping(e.target)) return
      // 모드 전환은 조작 권한이 필요하다 — 긴급 정지와 달리 안전 예외가 아니다
      if (latest.current.ctlOff) return
      // 포커스된 버튼의 기본 활성화(=중복 실행)와 페이지 스크롤을 막는다
      e.preventDefault()
      if (e.repeat) return
      // 순찰 ↔ 수동 토글 — Shift(긴급 정지 ↔ 순찰 복귀)와 같은 규칙
      latest.current.onSetSeg(latest.current.seg !== 'manual')
    }
    const onUp = (e: any) => {
      if (e.key !== 'Shift') return
      if (!shiftAlone) return
      shiftAlone = false
      if (isTyping(e.target)) return
      const s = latest.current
      // 순찰 복귀는 조작 권한이 필요하고, 긴급 정지는 로그인만 하면 누구나 할 수 있다
      if (s.estopEngaged) { if (!s.ctlOff) s.onReturnPatrol() }
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
  }, [estopOff])

  return (
    <div className="panel" id="pControl">
      <h3>
        순찰 로봇 수동 조작 패널 <span className="k">MANUAL CONTROL</span>
        {/* 서버 연결과 로봇 가동은 다른 이야기다 — 로봇이 꺼져 있어도 STOMP 는 붙어 있다.
            서버가 판정한 online(S15P11E101-510)이 false 면 그 사실을 따로 말한다. */}
        {enabled && <span className="k" style={{ marginLeft: 8, color: linkColor }}>
          {linkText}
        </span>}
        <CapBadge capKey={CAP_KEYS.drive} />
      </h3>
      <div className="ctl">
        {/* 비상·복구 조작은 이동 조작(방향 버튼·모드·지점 이동)과 떼어 놓는다 — 조작 중 오클릭 방지 */}
        <div className="col">
          {/* Shift 뱃지는 지금 그 키가 실행할 버튼에만 붙인다 — 어느 쪽으로 토글되는지 화면으로 알 수 있게 */}
          <button
            className="dbtn stop keyed"
            onClick={onEmergencyStop}
            disabled={estopOff}
            aria-keyshortcuts={estopEngaged ? undefined : 'Shift'}
          >
            <span>■ 긴급 정지</span>
            {!estopEngaged && <kbd className="kbd">Shift</kbd>}
          </button>
          <button
            className="dbtn go keyed"
            onClick={onReturnPatrol}
            disabled={ctlOff}
            aria-keyshortcuts={estopEngaged ? 'Shift' : undefined}
          >
            <span>⇤ 순찰 복귀</span>
            {estopEngaged && <kbd className="kbd">Shift</kbd>}
          </button>

          {/* 주행 속도와 카메라 각도는 배치가 같아(− 게이지 +) 가로로 나란히 둔다.
              세로로 쌓으면 낮은 창에서 카메라 각도가 먼저 밀려났다(S15P11E101-595). */}
          <div className="gauges">
          {/* 주행 속도 — 방향 단위벡터에 이 값을 곱해 발행한다 */}
          <div className="spd">
            <div className="spdlab">
              <span>주행 속도</span><b className="mono">{speed.toFixed(2)} m/s</b>
            </div>
            <div className="spdr">
              <button
                className="dbtn"
                onClick={() => onSetSpeed(speed - spd.step)}
                disabled={ctlOff || speed <= spd.min}
                aria-label="주행 속도 낮추기"
              >
                −
              </button>
              <div
                className="spdbar"
                role="slider"
                aria-label="주행 속도"
                aria-valuemin={spd.min}
                aria-valuemax={spd.max}
                aria-valuenow={speed}
                aria-valuetext={`${speed.toFixed(2)} m/s`}
              >
                <i style={{ width: `${speedPct}%` }} />
              </div>
              <button
                className="dbtn"
                onClick={() => onSetSpeed(speed + spd.step)}
                disabled={ctlOff || speed >= spd.max}
                aria-label="주행 속도 높이기"
              >
                +
              </button>
            </div>
          </div>

          {/* 카메라 상하 각도 — 주행 속도와 같은 '− 게이지 +' 배치(S15P11E101-521) */}
          <CameraTilt />
          </div>
        </div>

        {/* 우측 열 — 방향 패드·모드·지점 이동. 좌측 열과 아래 끝을 맞춘다(S15P11E101-595) */}
        <div className="ctl-right">
          {/* 실제 키보드 방향키(inverted-T): △ 위 / ◁ ▽ ▷ 아래 한 줄 */}
          <div className="dpad">
            <span />{key('w')}<span />
            {key('a')}{key('s')}{key('d')}
          </div>
          <div className="seg">
            <button
              className={seg === 'patrol' ? 'on' : ''}
              onClick={() => onSetSeg(false)}
              disabled={ctlOff}
              aria-keyshortcuts={seg === 'manual' ? 'Space' : undefined}
            >
              순찰 모드
              {/* Space 뱃지는 지금 그 키가 전환할 대상 버튼에만 붙인다 (Shift 뱃지와 같은 규칙) */}
              {seg === 'manual' && <kbd className="kbd">Space</kbd>}
            </button>
            <button
              className={seg === 'manual' ? 'on' : ''}
              onClick={() => onSetSeg(true)}
              disabled={ctlOff}
              aria-keyshortcuts={seg === 'patrol' ? 'Space' : undefined}
            >
              수동 모드
              {seg === 'patrol' && <kbd className="kbd">Space</kbd>}
            </button>
          </div>

          <div className="gotor">
            <select value={gotoId} onChange={(e) => setGotoId(e.target.value)} disabled={ctlOff}>
              {points.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button className="dbtn go" onClick={onGoto} disabled={ctlOff}>지점 이동</button>
          </div>
        </div>
      </div>
      {/* 명령이 조용히 버려진 경우를 알린다 — 패널 아래 한 줄로만 쓴다(S15P11E101-595) */}
      {ctlMsg && <div className={`ctlmsg ${ctlMsg.kind}`} id="ctlMsg" role="status">{ctlMsg.text}</div>}
    </div>
  )
}
