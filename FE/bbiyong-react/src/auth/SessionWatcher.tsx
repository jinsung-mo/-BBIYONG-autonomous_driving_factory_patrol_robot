import { useEffect, useState } from 'react'
import { useAuth } from './AuthContext.tsx'
import { errMessage } from '../live/errors.ts'

// 사용자 조작을 활동으로 기록하고, 유휴가 지나면 조작 잠금 화면을 띄운다 (S15P11E101-508 · 653).
// 로그인 상태에서만 마운트된다.
//
// 예전에는 유휴 60분에 '계속 사용하시겠습니까' 를 묻고 로그아웃했다. 무인 시간대 관제
// 화면에서는 그 물음이 밤새 11~12번 떴고, 놓치면 긴급 정지조차 누를 수 없었다.
// 이제는 묻지 않고 조작만 잠근다 — 화면은 계속 흐른다.
const INPUT_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove']

export default function SessionWatcher() {
  const { touch, locked, unlock, logout, user } = useAuth()
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // passive: 스크롤·터치 성능을 막지 않는다. capture: 하위에서 stopPropagation 해도 놓치지 않는다.
    const opts = { passive: true, capture: true }
    INPUT_EVENTS.forEach((e) => window.addEventListener(e, touch, opts))
    return () => INPUT_EVENTS.forEach((e) => window.removeEventListener(e, touch, opts))
  }, [touch])

  // 잠금이 풀리면 입력값을 남겨 두지 않는다
  useEffect(() => { if (!locked) { setPw(''); setErr(null) } }, [locked])

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

  // 화면 전체를 덮지 않는다 — 영상·지도·경보가 계속 보여야 관제다.
  // 조작 수단만 잠기고, 여기는 그 사실을 알리고 푸는 창구다.
  return (
    <div className="lockbar" role="dialog" aria-modal="false" aria-label="조작 잠금">
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
  )
}
