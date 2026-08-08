import { useEffect, useRef, useState } from 'react'
import { useAuth } from './AuthContext.tsx'
import { errMessage } from '../live/errors.ts'

// 사용자 조작을 활동으로 기록하고, 유휴가 지나면 조작 잠금 화면을 띄운다 (S15P11E101-508 · 653 · 815).
// 로그인 상태에서만 마운트된다.
//
// 예전에는 유휴 60분에 '계속 사용하시겠습니까' 를 묻고 로그아웃했다. 무인 시간대 관제
// 화면에서는 그 물음이 밤새 11~12번 떴고, 놓치면 긴급 정지조차 누를 수 없었다.
// 이제는 묻지 않고 조작만 잠근다 — 화면은 계속 흐른다.
const INPUT_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove']

// ---- 전면 차단 (S15P11E101-815) ----
// canOperate 는 화면 23곳이 각자 disabled 로 검사한다 — 새 컨트롤이 그 검사를 빠뜨리면
// 잠금 중에도 눌린다. 실제로 뚫려 있던 자리 하나: src/live/LiveSimBridge.tsx:106 의
// WASD→DRIVE 키 리스너는 driveMode 와 enabled/connected 만 보고 canOperate 는 보지
// 않는다 — 잠긴 채로도 키보드로 로봇이 실제 주행했다. 클릭은 아래 스크림이,
// 키보드는 이 캡처 단계 리스너가 막는다. 버블 단계에 있는 각 컴포넌트의 window
// 리스너(WASD 주행·Space 모드전환 등)에 이벤트가 닿기 전에 끊어, 새 리스너가 추가돼도
// canOperate 를 깜빡하면 여전히 막힌다 — 한 겹 방어를 앞단에 두는 것.
//
// 🔴 잠금 바 문구("긴급 정지는 잠금과 무관하게 누를 수 있습니다")를 그대로 지키려면
// 긴급 정지 컨트롤을 이 차단 위(스크림 위 z-index)로 올려야 한다. 그런데 이 저장소를
// 뒤져 봐도 긴급 정지 버튼도 단축키도 없다 — 둘 다 S15P11E101-735 에서 함께 제거됐다
// (components/robot/ControlPanel.tsx:198-200 주석: "버튼도 함께 지운 의도된 사양이다").
// 문구는 사용자 지침에 따라 바꾸지 않았지만, 지금은 예외로 둘 대상 자체가 없다.
// 나중에 긴급 정지 컨트롤이 되살아나면 그 요소(또는 감싸는 컨테이너)에
// `data-lock-exempt` 속성을 달면 이 차단과 아래 포커스 트랩을 함께 우회한다 —
// CSS 쪽 z-index 는 별도로 스크림(196)보다 위에 놓아야 한다.
const isExempt = (el: EventTarget | null) =>
  !!(el as HTMLElement | null)?.closest?.('[data-lock-exempt]')

export default function SessionWatcher() {
  const { touch, locked, unlock, logout, user } = useAuth()
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // passive: 스크롤·터치 성능을 막지 않는다. capture: 하위에서 stopPropagation 해도 놓치지 않는다.
    const opts = { passive: true, capture: true }
    INPUT_EVENTS.forEach((e) => window.addEventListener(e, touch, opts))
    return () => INPUT_EVENTS.forEach((e) => window.removeEventListener(e, touch, opts))
  }, [touch])

  // 잠금이 풀리면 입력값을 남겨 두지 않는다
  useEffect(() => { if (!locked) { setPw(''); setErr(null) } }, [locked])

  // 잠기는 순간 비밀번호 입력으로 포커스를 옮긴다 — 뒤에 남아 있던 포커스가
  // 그대로 Tab 경로에 끼어들지 않게 한다.
  useEffect(() => {
    if (!locked) return
    dialogRef.current?.querySelector<HTMLInputElement>('#lockPw')?.focus()
  }, [locked])

  // 키보드 차단 + 포커스 트랩을 한 리스너에서 같이 처리한다(캡처 단계 — 다른 window
  // 리스너들은 버블 단계라 항상 이보다 나중에 불린다). 둘을 따로 두면 안 되는 이유:
  // 트랩을 다이얼로그 자신의 keydown 리스너로만 두면, 스크림 클릭처럼 포커스가 다이얼로그
  // 밖(예: <body>)으로 빠진 순간부터는 그 리스너 자체가 다시는 불릴 기회가 없다 — Tab 을
  // 눌러도 다이얼로그가 그 이벤트를 받지 못해 영영 못 돌아온다. 그래서 Tab 은 지금
  // activeElement 가 어디든 상관없이 여기서 직접 다음 포커스를 계산해 옮긴다.
  useEffect(() => {
    if (!locked) return undefined
    const dialog = dialogRef.current
    const focusables = () => (dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>('input, button'))
        .filter((el) => !(el as HTMLInputElement | HTMLButtonElement).disabled && el.offsetParent !== null)
      : [])
    const onKeyDownCapture = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (isExempt(target)) return

      if (e.key === 'Tab') {
        const els = focusables()
        if (!els.length) return
        e.preventDefault()
        const idx = els.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey
          ? els[idx > 0 ? idx - 1 : els.length - 1]
          : els[idx >= 0 && idx < els.length - 1 ? idx + 1 : 0]
        next.focus()
        return
      }

      if (dialog?.contains(target)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDownCapture, true)
    return () => window.removeEventListener('keydown', onKeyDownCapture, true)
  }, [locked])

  if (!locked) return null

  const submit = async (e: any) => {
    e.preventDefault()
    if (busy || !pw) return
    setBusy(true); setErr(null)
    try {
      await unlock(pw)
    } catch (e2: any) {
      setErr(errMessage(e2) || '비밀번호가 올바르지 않습니다.')
      setPw('')
    } finally {
      setBusy(false)
    }
  }

  // 화면·경보 자체는 계속 흐른다(데이터 갱신은 스크림과 무관하다) — 다만 조작 수단은
  // 스크림이 물리적으로(포인터) + 위 캡처 리스너가(키보드) 전면 차단한다.
  // 잠금 다이얼로그만 스크림 위(z-index)에 뜬다.
  return (
    <>
      <div className="lock-scrim" aria-hidden="true" />
      <div ref={dialogRef} className="lockbar" role="dialog" aria-modal="true" aria-label="조작 잠금">
        <div className="lockbar-txt">
          <b>🔒 조작이 잠겼습니다</b>
          <span>화면과 경보는 계속 동작합니다. 긴급 정지는 잠금과 무관하게 누를 수 있습니다.</span>
        </div>
        <form className="lockbar-form" onSubmit={submit}>
          {/* 브라우저 비밀번호 관리자가 계정을 알아보게 이메일을 숨겨 함께 둔다 */}
          <input type="text" name="email" autoComplete="username" value={user?.email || ''}
            readOnly hidden aria-hidden="true" />
          <input
            id="lockPw"
            type="password"
            autoComplete="current-password"
            placeholder="비밀번호로 잠금 해제"
            aria-label="비밀번호"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            disabled={busy}
          />
          <button type="submit" id="btnUnlock" className="dbtn go" disabled={busy || !pw}>
            {busy ? '확인 중…' : '잠금 해제'}
          </button>
          <button type="button" className="dbtn" onClick={() => logout()}>로그아웃</button>
        </form>
        {err && <div className="lockbar-err" id="lockErr" role="alert">{err}</div>}
      </div>
    </>
  )
}
