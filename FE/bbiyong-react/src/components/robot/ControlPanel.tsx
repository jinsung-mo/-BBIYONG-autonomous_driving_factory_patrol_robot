import { useEffect, useRef, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { DRIVE_VECTORS } from '../../live/mappers.ts'
import { useAuth } from '../../auth/AuthContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import CapBadge from './CapBadge.tsx'
import CameraTilt from './CameraTilt.tsx'

// 순찰 로봇 수동 조작 패널 (WASD 이동 · 모드 · 카메라 각도)
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
  const { status, actions } = useSim()
  const {
    enabled, connected, control, telemetry, robotOnline,
    driveMode: seg, setDriveMode: setSeg,
  } = useLive()
  const { canOperate } = useAuth()
  // 조작 결과 안내 — 명령이 조용히 버려지는 경우를 알린다(S15P11E101-595)
  const [ctlMsg, setCtlMsg] = useState<{ kind: string, text: string } | null>(null)
  const resumeTimer = useRef<any>(null)

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
  // 잠금(S15P11E101-653)도 같은 자리에 얹는다. canOperate = 권한 있음 && 잠기지 않음.
  const ctlOff = (enabled && !connected) || driveDown || !canOperate
  // 안전 예외: 긴급 정지는 권한과 무관하게 로그인만 하면 누구나 즉시 누를 수 있어야 한다.
  // 잠금에도 열어 둔다 — 무인 시간대에 화재가 났는데 비밀번호부터 치게 만들 수는 없다.
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
  const [pressedKeys, setPressedKeys] = useState<Record<string, boolean>>({ w: false, a: false, s: false, d: false })

  // 화면의 눌림 표시도 실제 명령과 같은 수동 모드 게이트를 통과해야 한다.
  // 순찰 모드에서 전역 keydown만 받아 버튼이 눌린 것처럼 보이면 명령이 전송됐다고 오해할 수 있다.
  useEffect(() => {
    const clear = () => setPressedKeys((current) => Object.values(current).some(Boolean)
      ? { w: false, a: false, s: false, d: false }
      : current)
    if (!manual || ctlOff) { clear(); return undefined }
    const isTyping = (el: any) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
    const resolve = (e: any) => /^[wasd]$/.test(e.key.toLowerCase()) ? e.key.toLowerCase() : null
    const onDown = (e: any) => {
      if (isTyping(e.target)) return
      const key = resolve(e)
      if (!key) return
      setPressedKeys((current) => current[key] ? current : { ...current, [key]: true })
    }
    const onUp = (e: any) => {
      const key = resolve(e)
      if (!key) return
      setPressedKeys((current) => current[key] ? { ...current, [key]: false } : current)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [manual, ctlOff])

  // 버튼은 로봇 주행 전용 키보드 키(WASD)로 표기한다.
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
        className={pressedKeys[k] ? 'active' : ''}
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
    // WASD는 주행, 위/아래 방향키는 카메라 틸트 전용이다.
    const DRIVE_KEYS = /^[wasd]$/
    const CAMERA_KEYS = /^arrow(up|down)$/

    const onDown = (e: any) => {
      if (e.key === 'Shift') {
        if (!e.repeat && !isTyping(e.target)) { shiftAlone = true }
        return
      }
      // Shift 와 다른 키를 함께 누르면 단축키가 아니다
      shiftAlone = false
      // 주행 키는 모드를 건드리지 않는다(S15P11E101-513). 실제 주행 발행은
      // live 는 LiveSimBridge, mock 은 useSimulation 의 키 리스너가 맡는다.
      if (DRIVE_KEYS.test(e.key.toLowerCase()) || CAMERA_KEYS.test(e.key.toLowerCase())) return
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
    // 창을 벗어나면 keyup 을 못 받는다 — 눌린 채로 굳지 않게 함께 푼다
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
      <h3 className="control-titlebar">
        <span className="control-title">순찰 로봇 수동 조작 패널</span>
        <span className="k">MANUAL CONTROL</span>
        {/* 서버 연결과 로봇 가동은 다른 이야기다 — 로봇이 꺼져 있어도 STOMP 는 붙어 있다.
            서버가 판정한 online(S15P11E101-510)이 false 면 그 사실을 따로 말한다. */}
        {enabled && <span className="k" style={{ marginLeft: 8, color: linkColor }}>
          {linkText}
        </span>}
        <CapBadge capKey={CAP_KEYS.drive} />
      </h3>
      <div className="control-card">
        <div className="ctl">
          {/* 좌: 방향키 — 손이 가장 자주 가는 것이라 한 덩어리로 크게 둔다 */}
          <div className="ctl-pad">
            {/* 실제 키보드 방향키(inverted-T): W 위 / A S D 아래 한 줄 */}
            <div className="dpad">
              <span />{key('w')}<span />
              {key('a')}{key('s')}{key('d')}
            </div>
          </div>

          {/* 좁은 좌측 패널에서는 모드 → 방향키 → 카메라 각도 순으로 세로 정렬된다. */}
          <div className="ctl-right">
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

            {/* 카메라 상하 각도 — 모드 바로 아래(S15P11E101-521) */}
            <CameraTilt manual={manual} />
          </div>
        </div>
        {/* 명령이 조용히 버려진 경우를 알린다 — 패널 아래 한 줄로만 쓴다(S15P11E101-595) */}
        {ctlMsg && <div className={`ctlmsg ${ctlMsg.kind}`} id="ctlMsg" role="status">{ctlMsg.text}</div>}
      </div>
    </div>
  )
}
