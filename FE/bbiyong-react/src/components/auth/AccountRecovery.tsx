import { useState } from 'react'
import { errMessage } from '../../live/errors.ts'
import {
  findIdRequest, sendResetCode, resetPasswordRequest,
} from '../../live/authApi.ts'
import {
  formatPhone, phoneDigits, passwordChecks, todayISO, MIN_BIRTH_ISO,
} from '../../auth/signupRules.ts'
import PasswordChecklist from './PasswordChecklist.tsx'

// 아이디(이메일) 찾기 · 비밀번호 재설정 화면 (S15P11E101).
// AuthScreen 카드 안에서 mode 에 따라 렌더된다. 두 흐름 모두 실서버 전용이라,
// 시뮬레이션 모드에서는 안내만 보여 준다(mock 계정 저장소에는 인증/발송 개념이 없다).

function LiveOnlyNotice() {
  return (
    <div className="form-msg warn">
      이 기능은 실서버 계정에만 사용할 수 있습니다. 상단에서 실서버 모드로 전환해 주세요.
    </div>
  )
}

function FindIdPanel({ live }: { live: boolean }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [birth, setBirth] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState('')

  const submit = async (e: any) => {
    e.preventDefault()
    if (busy) return
    setErr(''); setResult('')
    if (!name.trim()) { setErr('이름을 입력하세요.'); return }
    if (!phone.trim()) { setErr('휴대전화번호를 입력하세요.'); return }
    if (!birth) { setErr('생년월일을 입력하세요.'); return }
    setBusy(true)
    try {
      const res = await findIdRequest(name.trim(), phoneDigits(phone), birth)
      setResult(res?.maskedEmail || '')
    } catch (e2) {
      setErr(errMessage(e2))
    } finally { setBusy(false) }
  }

  if (!live) return <LiveOnlyNotice />

  return (
    <form onSubmit={submit}>
      <p className="auth-hint" style={{ marginTop: 0, marginBottom: 14 }}>
        가입 시 등록한 이름·휴대전화번호·생년월일로 이메일(아이디)을 찾습니다.
      </p>
      <div className="form-row">
        <label htmlFor="fi-name">이름</label>
        <input id="fi-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="가입자 이름" autoComplete="name" disabled={busy} />
      </div>
      <div className="form-row">
        <label htmlFor="fi-phone">휴대전화번호</label>
        <input id="fi-phone" type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} placeholder="010-0000-0000" autoComplete="tel" disabled={busy} />
      </div>
      <div className="form-row">
        <label htmlFor="fi-birth">생년월일</label>
        <input id="fi-birth" type="date" value={birth} onChange={(e) => setBirth(e.target.value)} min={MIN_BIRTH_ISO} max={todayISO()} autoComplete="bday" disabled={busy} />
      </div>
      {err && <div className="form-msg err">{err}</div>}
      {result && (
        <div className="form-msg ok">
          가입된 이메일: <strong>{result}</strong>
        </div>
      )}
      <button type="submit" className="auth-submit" disabled={busy}>
        {busy ? '조회 중…' : '아이디 찾기'}
      </button>
    </form>
  )
}

function ResetPasswordPanel({ live }: { live: boolean }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState(false)

  const send = async () => {
    if (busy) return
    setErr(''); setNotice('')
    if (!email.trim()) { setErr('이메일을 입력하세요.'); return }
    setBusy(true)
    try {
      await sendResetCode(email.trim().toLowerCase())
      setSent(true)
      setNotice('가입된 이메일이라면 인증코드를 발송했습니다. 메일함을 확인하세요.')
    } catch (e2) {
      setErr(errMessage(e2))
    } finally { setBusy(false) }
  }

  const submit = async (e: any) => {
    e.preventDefault()
    if (busy) return
    setErr(''); setNotice('')
    if (!code.trim()) { setErr('인증코드를 입력하세요.'); return }
    if (passwordChecks(pw).some((c) => !c.ok)) { setErr('비밀번호 조건을 모두 충족해야 합니다.'); return }
    if (pw !== pw2) { setErr('비밀번호가 일치하지 않습니다.'); return }
    setBusy(true)
    try {
      await resetPasswordRequest(email.trim().toLowerCase(), code.trim(), pw)
      setDone(true)
    } catch (e2) {
      setErr(errMessage(e2))
    } finally { setBusy(false) }
  }

  if (!live) return <LiveOnlyNotice />

  if (done) {
    return (
      <div className="form-msg ok" role="status">
        비밀번호가 변경되었습니다. 로그인 화면에서 새 비밀번호로 로그인하세요.
      </div>
    )
  }

  return (
    <form onSubmit={submit}>
      <p className="auth-hint" style={{ marginTop: 0, marginBottom: 14 }}>
        가입한 이메일로 인증코드를 받아 비밀번호를 재설정합니다.
      </p>
      <div className="form-row">
        <label htmlFor="rp-email">이메일</label>
        <div className="inline-field">
          <input id="rp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="username" disabled={busy || sent} />
          <button type="button" className="inline-btn" onClick={send} disabled={busy || !email.trim()}>
            {sent ? '재전송' : '코드 전송'}
          </button>
        </div>
      </div>
      {sent && (
        <>
          <div className="form-row">
            <label htmlFor="rp-code">인증코드</label>
            <input id="rp-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="메일로 받은 6자리 코드" disabled={busy} />
          </div>
          <div className="form-row">
            <label htmlFor="rp-pw">새 비밀번호</label>
            <input id="rp-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="영문·숫자·특수문자 포함 8자 이상" autoComplete="new-password" disabled={busy} />
            <PasswordChecklist password={pw} />
          </div>
          <div className="form-row">
            <label htmlFor="rp-pw2">새 비밀번호 확인</label>
            <input id="rp-pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="새 비밀번호 확인" autoComplete="new-password" disabled={busy} />
            {pw2 && pw !== pw2 && <div className="field-hint miss">비밀번호가 일치하지 않습니다.</div>}
          </div>
        </>
      )}
      {notice && !err && <div className="form-msg warn">{notice}</div>}
      {err && <div className="form-msg err">{err}</div>}
      {sent && (
        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? '처리 중…' : '비밀번호 재설정'}
        </button>
      )}
    </form>
  )
}

export default function AccountRecovery({ mode, live }: { mode: 'find-id' | 'reset-pw', live: boolean }) {
  return mode === 'find-id'
    ? <FindIdPanel live={live} />
    : <ResetPasswordPanel live={live} />
}
