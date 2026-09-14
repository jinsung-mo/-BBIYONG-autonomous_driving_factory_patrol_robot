import { useState } from 'react'
import { errMessage } from '../../live/errors.ts'
import {
  findIdRequest, sendResetCode, resetPasswordRequest,
  sendResetCodeByPhone, resetPasswordByPhoneRequest,
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
  // 🔴 이메일이 기억나지 않는 사용자를 위한 두 번째 경로(S15P11E101-846).
  // SMS 는 오지 않는다 — 우리에게 발송 수단이 없다. 휴대전화로 계정을 찾아 **그 계정의
  // 이메일로** 같은 코드를 보내고, 어느 메일함인지 마스킹 값으로 알려 준다.
  // 두 경로의 2단계(코드+새 비밀번호)는 완전히 같아서 아래 폼을 공유한다.
  const [by, setBy] = useState<'email' | 'phone'>('email')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [birth, setBirth] = useState('')
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState(false)

  // 경로를 바꾸면 발송 상태부터 되돌린다 — 이메일로 코드를 받아 둔 채 휴대전화 탭으로
  // 넘어가면, 입력칸은 비어 있는데 아래에 코드 입력이 떠 있는 모순된 화면이 된다.
  const switchBy = (next: 'email' | 'phone') => {
    if (next === by) return
    setBy(next); setSent(false); setCode(''); setErr(''); setNotice('')
  }

  const send = async () => {
    if (busy) return
    setErr(''); setNotice('')
    if (by === 'email') {
      if (!email.trim()) { setErr('이메일을 입력하세요.'); return }
    } else {
      if (!name.trim()) { setErr('이름을 입력하세요.'); return }
      if (!phone.trim()) { setErr('휴대전화번호를 입력하세요.'); return }
      if (!birth) { setErr('생년월일을 입력하세요.'); return }
    }
    setBusy(true)
    try {
      if (by === 'email') {
        await sendResetCode(email.trim().toLowerCase())
        setNotice('가입된 이메일이라면 인증코드를 발송했습니다. 메일함을 확인하세요.')
      } else {
        const res = await sendResetCodeByPhone(name.trim(), phoneDigits(phone), birth)
        // 어느 메일함을 열어야 하는지 알려 준다 — 이 경로를 쓰는 사람은 애초에 자기
        // 이메일이 기억나지 않아서 왔다. 마스킹 값이라도 있어야 메일함을 찾아간다.
        setNotice(res?.maskedEmail
          ? `${res.maskedEmail} 로 인증코드를 발송했습니다. 메일함을 확인하세요.`
          : '인증코드를 발송했습니다. 메일함을 확인하세요.')
      }
      setSent(true)
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
      if (by === 'email') {
        await resetPasswordRequest(email.trim().toLowerCase(), code.trim(), pw)
      } else {
        // 화면이 아는 이메일은 마스킹된 값뿐이라 다시 보낼 수 없다 — 본인 확인 3종을
        // 실어 서버가 계정을 재확인하게 한다.
        await resetPasswordByPhoneRequest(name.trim(), phoneDigits(phone), birth, code.trim(), pw)
      }
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
      {/* 무엇으로 본인을 확인할지 고른다. 로그인/회원가입 탭과 같은 세그먼트 필을 쓴다 —
          같은 카드 안의 같은 성격(둘 중 하나)이라 다른 모양을 낼 이유가 없다. */}
      <div className="auth-seg" role="tablist" aria-label="비밀번호 찾기 방법">
        <button type="button" role="tab" aria-selected={by === 'email'} className={by === 'email' ? 'on' : ''} onClick={() => switchBy('email')} disabled={busy}>이메일로 찾기</button>
        <button type="button" role="tab" aria-selected={by === 'phone'} className={by === 'phone' ? 'on' : ''} onClick={() => switchBy('phone')} disabled={busy}>휴대폰으로 찾기</button>
      </div>
      <p className="auth-hint" style={{ marginTop: 0, marginBottom: 14 }}>
        {by === 'email'
          ? '가입한 이메일로 인증코드를 받아 비밀번호를 재설정합니다.'
          /* 🔴 문자로 오지 않는다는 걸 먼저 말한다 — '휴대폰으로 찾기' 를 누른 사람은
             문자를 기다린다. 기다리다 실패하는 것보다 먼저 알려 주는 편이 낫다. */
          : '이름·휴대전화번호·생년월일로 계정을 찾아, 그 계정의 이메일로 인증코드를 보냅니다. (문자로는 발송되지 않습니다)'}
      </p>
      {by === 'email' ? (
        <div className="form-row">
          <label htmlFor="rp-email">이메일</label>
          <div className="inline-field">
            <input id="rp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="username" disabled={busy || sent} />
            <button type="button" className="inline-btn" onClick={send} disabled={busy || !email.trim()}>
              {sent ? '재전송' : '코드 전송'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="form-row">
            <label htmlFor="rp-name">이름</label>
            <input id="rp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="가입자 이름" autoComplete="name" disabled={busy || sent} />
          </div>
          <div className="form-row">
            <label htmlFor="rp-phone">휴대전화번호</label>
            <input id="rp-phone" type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} placeholder="010-0000-0000" autoComplete="tel" disabled={busy || sent} />
          </div>
          <div className="form-row">
            <label htmlFor="rp-birth">생년월일</label>
            <div className="inline-field">
              <input id="rp-birth" type="date" value={birth} onChange={(e) => setBirth(e.target.value)} min={MIN_BIRTH_ISO} max={todayISO()} autoComplete="bday" disabled={busy || sent} />
              <button type="button" className="inline-btn" onClick={send} disabled={busy || !name.trim() || !phone.trim() || !birth}>
                {sent ? '재전송' : '코드 전송'}
              </button>
            </div>
          </div>
        </>
      )}
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
