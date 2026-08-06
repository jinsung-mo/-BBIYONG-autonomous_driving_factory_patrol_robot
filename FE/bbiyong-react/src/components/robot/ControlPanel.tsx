import { useEffect, useRef, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { DRIVE_VECTORS } from '../../live/mappers.ts'
import { useAuth } from '../../auth/AuthContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import CapBadge from './CapBadge.tsx'
import CameraTilt from './CameraTilt.tsx'
import { DENY, formatLeft } from '../../live/controlOwnership.ts'

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
    ownership, controlOwnership,
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

  // ---- 조종 점유 (S15P11E101-778 · 779 / BE MR !344) ----
  //
  // 남이 조종 중이면 수동 모드 진입 버튼 자체를 잠근다. 다만 점유 기능이 없는 서버
  // (MR !344 머지 전)에서는 /topic/control 이 한 번도 오지 않아 supported 가 false 로 남는데,
  // 그것을 이유로 수동 주행을 막으면 지금 배포본이 통째로 멈춘다 — 모르면 열어 둔다.
  // 막는 것은 "남이 잡고 있다는 사실을 서버에서 확인했을 때" 뿐이다.
  const ownedByOther = ownership.supported && ownership.otherOwns
  // 하트비트가 끊긴 구간. 마지막으로 본 값을 지금의 사실인 양 단언하지 않는다.
  const ownStale = ownership.supported && ownership.stale
  const ownerName = ownership.ownerEmail || '다른 사용자'
  const leftLabel = formatLeft(ownership.leftMs)
  // 내가 조종자인데 갱신이 3초 넘게 끊겼다. 서버 리스는 2초라 그사이 만료됐을 공산이 크고,
  // 그렇다면 내 DRIVE 는 지금 서버에서 조용히 버려지고 있다 — 조이스틱을 열어 두면 거짓말이다.
  // 모드에서 내쫓지는 않는다. 방송이 돌아오면 그대로 이어서 조종할 수 있어야 한다.
  const ownUnsure = ownStale && ownership.mine

  const denyText: Record<string, string> = {
    [DENY.FORBIDDEN_ROLE]: '조종 권한이 없습니다 — 관리자 계정으로만 조작할 수 있습니다.',
    [DENY.OWNED_BY_OTHER]: `${ownerName} 님이 조종 중이라 수동 모드로 들어갈 수 없습니다.`,
    [DENY.TAKEN_OVER_BY_OTHER]: `${ownerName} 님이 조종권을 가져갔습니다 — 조작이 잠겼습니다.`,
  }
  const deniedMsg = ownership.denied ? (denyText[ownership.denied.reason] || '조종 요청이 거부되었습니다.') : null

  // 강제 탈취는 파괴적이다 — 남이 로봇을 움직이는 중에 그 사람의 조종을 끊고, 서버가
  // DRIVE(0,0) 정지 프레임을 강제로 쏜다. 누구의 조종을 끊는지 이름을 보여주고 확인받는다.
  const onTakeover = () => {
    const ok = window.confirm(
      `${ownerName} 님이 지금 이 로봇을 조종하고 있습니다.\n\n`
      + '조종권을 강제로 가져오면 그 사람의 조작이 즉시 잠기고 로봇은 한 번 정지합니다.\n'
      + '계속하시겠습니까?')
    if (!ok) return
    controlOwnership.takeover()
    setSeg('manual')
  }

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
        // 순찰 중에는 주행 명령이 무효다 — 눌러도 아무 일이 없는 버튼으로 두지 않고 잠근다.
        // 점유를 확인할 수 없는 구간(ownUnsure)도 같다 — 서버가 버릴 명령을 받아 주면 안 된다.
        disabled={ctlOff || !manual || ownUnsure}
        title={ownUnsure ? '조종 점유를 확인하는 중입니다' : (!manual ? '수동 모드에서 조작할 수 있습니다 (Space)' : undefined)}
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

  const onSetSeg = (man: any) => {
    // 남이 잡고 있으면 수동으로 못 들어간다 — 서버도 거부하므로 화면만 바뀌면 거짓말이 된다.
    // 순찰로 나오는 것(man=false)은 언제나 허용한다.
    if (man && ownedByOther) return
    setSeg(man ? 'manual' : 'patrol')
    if (liveReady) { control.setMode(man ? 'manual' : 'autonomy'); warnIfOffline() }
    else actions.setSeg(man)
  }

  // ---- 단축키 ----
  // 리스너는 enabled/connected 가 바뀔 때만 다시 걸고, 그때그때의 상태·핸들러는 ref로 읽는다
  // (핸들러가 매 렌더 새로 만들어지므로 의존성에 넣으면 리스너를 계속 재등록하게 된다).
  const latest = useRef<any>(null)
  latest.current = { estopEngaged, seg, ctlOff, onSetSeg }

  // E-STOP 이 실제로 풀리면 경고를 지운다 — 해결된 안내가 남아 있으면 다음 판단을 흐린다.
  useEffect(() => {
    if (estopEngaged) return
    clearTimeout(resumeTimer.current)
    setCtlMsg((m) => (m?.kind === 'err' ? null : m))
  }, [estopEngaged])
  useEffect(() => () => clearTimeout(resumeTimer.current), [])

  useEffect(() => {
    // 남은 단축키는 Space(순찰 ↔ 수동) 하나다. 긴급 정지·순찰 복귀 단축키는
    // S15P11E101-735 에서 없앴고, 되살리지 않는다 — 버튼도 함께 지운 의도된 사양이다.
    //
    // 글자를 입력하는 요소에서만 막는다. select 는 Space 로 글자가 들어가지 않으므로
    // 드롭다운을 건드렸다는 이유로 모드 전환이 죽어서는 안 된다(S15P11E101-595).
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
      // 주행 키는 모드를 건드리지 않는다(S15P11E101-513). 실제 주행 발행은
      // live 는 LiveSimBridge, mock 은 useSimulation 의 키 리스너가 맡는다.
      if (DRIVE_KEYS.test(e.key.toLowerCase()) || CAMERA_KEYS.test(e.key.toLowerCase())) return
      if (e.code !== 'Space') return
      if (isTyping(e.target)) return
      // 모드 전환은 조작 권한이 필요하다
      if (latest.current.ctlOff) return
      // 포커스된 버튼의 기본 활성화(=중복 실행)와 페이지 스크롤을 막는다
      e.preventDefault()
      if (e.repeat) return
      // 순찰 ↔ 수동 토글
      latest.current.onSetSeg(latest.current.seg !== 'manual')
    }
    window.addEventListener('keydown', onDown)
    return () => window.removeEventListener('keydown', onDown)
  }, [])

  return (
    <div className="panel" id="pControl">
      <h3 className="control-titlebar">
        <span className="control-title">순찰 로봇 수동 조작 패널</span>
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
                // 남이 조종 중이면 눌러도 서버가 거부한다 — 눌리는 버튼으로 두지 않는다
                disabled={ctlOff || ownedByOther}
                title={ownedByOther ? `${ownerName} 님이 조종 중입니다` : undefined}
                aria-keyshortcuts={seg === 'patrol' ? 'Space' : undefined}
              >
                수동 모드
                {seg === 'patrol' && !ownedByOther && <kbd className="kbd">Space</kbd>}
              </button>
            </div>

            {/* 카메라 상하 각도 — 모드 바로 아래(S15P11E101-521) */}
            <CameraTilt manual={manual} />
          </div>
        </div>
        {/* 조종 점유 배너 — 누가 잡고 있는지와 남은 시간을 그대로 보여 준다.
            갱신이 끊기면(stale) 남은 시간을 단언하지 않고 '확인 중'으로 내린다. */}
        {ownedByOther && (
          <div className="ctlown warn" id="ctlOwn" role="status">
            <span className="ctlown-txt">
              <b>{ownerName}</b> 님이 조종 중입니다
              {ownStale ? ' — 점유 상태 확인 중…' : ` (남은 ${leftLabel}초)`}
            </span>
            <button className="ctlown-take" onClick={onTakeover} disabled={ctlOff}>
              강제 탈취
            </button>
          </div>
        )}
        {ownership.mine && (
          <div className="ctlown mine" id="ctlOwnMine" role="status">
            <span className="ctlown-txt">
              내가 조종 중입니다{ownStale ? ' — 점유 상태 확인 중…' : ` (남은 ${leftLabel}초)`}
            </span>
          </div>
        )}
        {/* 거부 사유는 서버가 개인 큐로 알려 준 것을 그대로 옮긴다(S15P11E101-779) */}
        {deniedMsg && (
          <div className="ctlmsg err" id="ctlDenied" role="alert" onClick={controlOwnership.clearDenied}>
            {deniedMsg}
          </div>
        )}
        {/* 명령이 조용히 버려진 경우를 알린다 — 패널 아래 한 줄로만 쓴다(S15P11E101-595) */}
        {ctlMsg && <div className={`ctlmsg ${ctlMsg.kind}`} id="ctlMsg" role="status">{ctlMsg.text}</div>}
      </div>
    </div>
  )
}
