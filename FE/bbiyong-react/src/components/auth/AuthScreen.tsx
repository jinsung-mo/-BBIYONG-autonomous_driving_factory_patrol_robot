import { errMessage, errStatus } from '../../live/errors.ts'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import { saveDataSource } from '../../live/config.ts'
import { GENDERS, formatPhone, validateSignup, todayISO, MIN_BIRTH_ISO } from '../../auth/signupRules.ts'
import { REASON_TEXT } from '../../auth/sessionPolicy.ts'
import { sendSignupCode, verifySignupCode } from '../../live/authApi.ts'
import PasswordChecklist from './PasswordChecklist.tsx'
import AccountRecovery from './AccountRecovery.tsx'

// 로그인 / 회원가입 게이트 (로그아웃 상태에서 표시)
//
// 실서버 모드는 §2 REST로 로그인해 accessToken을 확보한다. 이 토큰이 STOMP CONNECT에도
// 실리므로(§1), 어느 모드로 로그인했는지가 이후 실시간 연동 가능 여부를 결정한다.
// → 모드 선택을 로그인 화면에 함께 둔다.
const EMPTY = { email: '', password: '', password2: '', name: '', phone: '', birth: '', gender: '' }

/** @param {{ onBack?: (() => void) | null }} props */
export default function AuthScreen({ onBack }: { onBack?: (() => void) | null }) {
  const { login, signup, logoutReason } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'signup' | 'find-id' | 'reset-pw'
  const [form, setForm] = useState(EMPTY)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // 시뮬레이션(mock) 진입을 제거했다(S15P11E101 콘솔 정리) — 항상 실서버로 접속한다.
  const live = true
  const recovery = mode === 'find-id' || mode === 'reset-pw'
  useEffect(() => { saveDataSource('live') }, [])

  // 이메일 인증(실서버 회원가입 전용). 서버가 이메일 기준으로 인증 상태를 들고 있으므로
  // 화면은 '코드 전송 → 검증 성공' 만 확인하면 된다. 이메일을 고치면 인증은 무효가 된다.
  const [emailSent, setEmailSent] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [emailVerified, setEmailVerified] = useState(false)
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailMsg, setEmailMsg] = useState('')

  const resetEmailVerify = useCallback(() => {
    setEmailSent(false); setEmailCode(''); setEmailVerified(false); setEmailBusy(false); setEmailMsg('')
  }, [])

  const reset = useCallback(() => { setForm(EMPTY); setErr(''); resetEmailVerify() }, [resetEmailVerify])

  const set = (k: any) => (e: any) => setForm((f) => ({ ...f, [k]: e.target.value }))
  // 이메일을 고치면 이전 인증은 무효다 — 다른 주소를 인증해 둔 채 가입되는 것을 막는다.
  const setEmail = (e: any) => { setForm((f) => ({ ...f, email: e.target.value })); resetEmailVerify() }
  // 휴대전화번호는 입력하는 대로 하이픈을 넣는다(숫자 외 문자는 버린다)
  const setPhone = (e: any) => setForm((f) => ({ ...f, phone: formatPhone(e.target.value) }))

  const switchMode = (m: any) => { setMode(m); reset() }

  // 회원가입 이메일 인증코드 전송/검증. 실패 문구는 emailMsg 로 인라인 표시한다.
  const sendEmailCode = async () => {
    if (emailBusy) return
    setEmailMsg(''); setErr('')
    const email = form.email.trim().toLowerCase()
    if (!email) { setEmailMsg('이메일을 먼저 입력하세요.'); return }
    setEmailBusy(true)
    try {
      await sendSignupCode(email)
      setEmailSent(true)
      setEmailMsg('인증코드를 발송했습니다. 메일함을 확인하세요.')
    } catch (e2) {
      setEmailMsg(errMessage(e2))
    } finally { setEmailBusy(false) }
  }

  const verifyEmailCode = async () => {
    if (emailBusy) return
    setEmailMsg('')
    const email = form.email.trim().toLowerCase()
    if (!emailCode.trim()) { setEmailMsg('인증코드를 입력하세요.'); return }
    setEmailBusy(true)
    try {
      await verifySignupCode(email, emailCode.trim())
      setEmailVerified(true)
      setEmailMsg('이메일 인증이 완료되었습니다.')
    } catch (e2) {
      setEmailMsg(errMessage(e2))
    } finally { setEmailBusy(false) }
  }

  // 뒤로가기(bfcache)로 이 화면에 돌아오면 이전 입력이 그대로 살아 있다.
  // bfcache 는 JS 힙까지 복원하므로 컴포넌트 상태도 남는다 — 복원 시점에 비운다.
  // 공용 PC 에서 앞사람의 이메일·이름이 보이면 안 된다.
  useEffect(() => {
    const onShow = (e: any) => { if (e.persisted) reset() }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [reset])

  const submit = async (e: any) => {
    e.preventDefault()
    // disabled 버튼만으로는 Enter 재제출을 완전히 막는다는 보장이 없다.
    if (busy) return
    setErr('')
    if (mode === 'login') {
      if (!form.email.trim()) { setErr('이메일을 입력하세요.'); return }
      if (!form.password) { setErr('비밀번호를 입력하세요.'); return }
    }
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(form.email.trim(), form.password)
      } else {
        // 날짜 입력의 min/max 는 브라우저가 먼저 막지만, 붙여넣기·자동완성·구형 브라우저를
        // 대비해 같은 규칙을 JS 로 한 번 더 본다.
        const problem = validateSignup(form)
        if (problem) throw new Error(problem)
        // 실서버 가입은 이메일 소유 확인이 끝나야 한다(서버도 동일하게 강제한다).
        if (live && !emailVerified) throw new Error('이메일 인증을 먼저 완료하세요.')
        await signup({
          email: form.email.trim(),
          password: form.password,
          name: form.name.trim(),
          phone: form.phone.trim(),
          birth: form.birth,
          gender: form.gender,
        })
      }
      reset() // 성공하면 입력을 남기지 않는다
    } catch (e2) {
      // 로그인 401의 서버 문구는 계정별로 달라질 수 있다. 화면은 계정 존재 여부를
      // 드러내지 않는 한 문장으로 고정한다.
      setErr(mode === 'login' && errStatus(e2) === 401
        ? '이메일 또는 비밀번호가 올바르지 않습니다.'
        : errMessage(e2))
    } finally { setBusy(false) }
  }

  return (
    <div className="auth-wrap">
      {/* 🔴 이 화면의 배경은 더 이상 자기 것이 아니다(S15P11E101-808). 전에는 여기에
          전용 씬(순찰 경로 2줄 + 마커 2개)을 그렸는데, 이제는 웰컴과 공유하는 순찰 씬
          (AuthFlow 의 PatrolScene)이 뒤에 살아 있고 그 위에 스크림이 블러를 건다.
          두 씬을 겹쳐 두면 흐려진 경로선이 두 벌 보여 지저분하므로 전용 씬은 걷어냈다.

          1단 패널. 🔴 유리(.bb-glass)를 쓰지 않는다 — 스크림이 이미 backdrop-filter 를
          쓰고 있어 여기에 또 걸면 tokens.css 가 금지하는 "유리 위에 유리"(블러 중첩)가
          된다. 대신 반투명 단색(app.css)으로 간다. 스크림(.42)+패널(.74) 두 겹의 흰
          반투명이 쌓여 실질적으로 밝은 면이 되므로, 그 위 순백 카드(.col)와의
          "패널 > 카드" 계층은 -807 그대로 선다. */}
      <div className={`auth-glass${mode === 'signup' ? ' is-signup' : ''}`}>
        <div className="auth-brand">삐용(BBIYONG)</div>
        {/* 세그먼트 필(S15P11E101-791). 탭 그룹을 알약 하나로 — 선택만 진하게 채운다.
            아이디/비밀번호 찾기(recovery)에서는 로그인·회원가입 탭 대신 제목을 보여 준다.
            🔴 접속 모드(시뮬레이션/실서버) 세그먼트는 걷어냈다 — 콘솔 정리(-850)로
            mock 진입 자체가 없어졌으므로, 선택지가 하나뿐인 라디오가 남아 있었다. */}
        {recovery ? (
          <div className="auth-title">{mode === 'find-id' ? '아이디(이메일) 찾기' : '비밀번호 찾기'}</div>
        ) : (
          <div className="auth-seg" role="tablist" aria-label="로그인 또는 회원가입">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchMode('login')} disabled={busy}>로그인</button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => switchMode('signup')} disabled={busy}>회원가입</button>
          </div>
        )}
        {recovery ? (
          /* 계정 찾기는 2열로 펼 것이 없다 — .fields 그리드를 태우지 않고 1열로 둔다. */
          <>
            <AccountRecovery mode={mode as 'find-id' | 'reset-pw'} live={live} />
            <button type="button" className="auth-back" onClick={() => switchMode('login')}>← 로그인으로</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="fields">
              {/* 2단 · 왼쪽 카드 — 계정 정보. 로그인 모드에서는 이 카드만 남는다.
                  🔴 열 제목("계정 정보")은 지웠다 [사용자 지침 2026-08-08] — .col 의
                  padding-top 을 그만큼 올려 카드 상단 여백이 무너지지 않게 했다. */}
              <div className="col">
                <div className="form-row">
                  <label htmlFor="au-email">이메일</label>
                  {/* placeholder 는 예시여야 한다(S15P11E101-802). 전에는 실제 데모 계정
                      주소(safety@bbiyong.io)를 썼는데, 도메인이 실재하는 것처럼 읽혀
                      값인지 안내인지 구분되지 않았다. example.com 은 예약 도메인이라
                      실재할 수 없고, 그래서 '예시' 라는 신호가 선다.
                      가입 화면은 형식보다 '무엇을 넣어야 하는지' 가 먼저다. */}
                  <input
                    id="au-email" type="email" value={form.email} onChange={setEmail}
                    placeholder={mode === 'signup' ? '업무용 이메일 주소' : 'name@example.com'}
                    autoComplete="username" disabled={busy || (mode === 'signup' && emailVerified)}
                  />
                </div>
                {/* 이메일 인증(실서버 회원가입). 인증을 마쳐야 가입 버튼이 동작한다.
                    이메일 바로 아래에 둔다 — 인증 대상이 위 칸의 값이라 떨어뜨리면 무엇을
                    인증하는지가 흐려진다. */}
                {mode === 'signup' && live && (
                  <div className="form-row">
                    <label htmlFor="au-email-code">이메일 인증</label>
                    {emailVerified ? (
                      <div className="field-hint ok">✓ 이메일 인증 완료</div>
                    ) : !emailSent ? (
                      <button type="button" className="inline-btn full" onClick={sendEmailCode} disabled={emailBusy || !form.email.trim()}>
                        {emailBusy ? '전송 중…' : '인증코드 전송'}
                      </button>
                    ) : (
                      <div className="inline-field">
                        <input id="au-email-code" inputMode="numeric" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} placeholder="6자리 코드" disabled={emailBusy} />
                        <button type="button" className="inline-btn" onClick={verifyEmailCode} disabled={emailBusy || !emailCode.trim()}>확인</button>
                        <button type="button" className="inline-btn ghost" onClick={sendEmailCode} disabled={emailBusy}>재전송</button>
                      </div>
                    )}
                    {emailMsg && <div className={`field-hint ${emailVerified ? 'ok' : 'miss'}`}>{emailMsg}</div>}
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="au-pw">비밀번호</label>
                  <input id="au-pw" type="password" value={form.password} onChange={set('password')} placeholder={mode === 'signup' ? '영문·숫자·특수문자 포함 8자 이상' : '비밀번호'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} disabled={busy} />
                  {mode === 'signup' && <PasswordChecklist password={form.password} />}
                </div>
                {mode === 'signup' && (
                  <div className="form-row">
                    <label htmlFor="su-pw2">비밀번호 확인</label>
                    <input id="su-pw2" type="password" value={form.password2} onChange={set('password2')} placeholder="비밀번호 확인" autoComplete="new-password" disabled={busy} />
                    {form.password2 && form.password !== form.password2 && (
                      <div className="field-hint miss">비밀번호가 일치하지 않습니다.</div>
                    )}
                  </div>
                )}
              </div>

              {/* 2단 · 오른쪽 카드 — 개인 정보. 회원가입 전용, 카드째로 사라진다. */}
              {mode === 'signup' && (
                <div className="col">
                  <div className="form-row">
                    <label htmlFor="su-name">이름</label>
                    <input id="su-name" value={form.name} onChange={set('name')} placeholder="관리자 이름" autoComplete="name" disabled={busy} />
                  </div>
                  <div className="form-row">
                    <label htmlFor="su-phone">휴대전화번호</label>
                    <input id="su-phone" type="tel" inputMode="numeric" value={form.phone} onChange={setPhone} placeholder="010-0000-0000" autoComplete="tel" disabled={busy} />
                  </div>
                  <div className="form-row">
                    <label htmlFor="su-birth">생년월일</label>
                    <input id="su-birth" type="date" value={form.birth} onChange={set('birth')} min={MIN_BIRTH_ISO} max={todayISO()} autoComplete="bday" disabled={busy} />
                  </div>
                  <div className="form-row">
                    <label id="su-gender-label">성별</label>
                    <div className="seg gender" role="radiogroup" aria-labelledby="su-gender-label">
                      {GENDERS.map((g) => (
                        <button
                          key={g.value}
                          type="button"
                          role="radio"
                          aria-checked={form.gender === g.value}
                          className={form.gender === g.value ? 'on' : ''}
                          onClick={() => setForm((f) => ({ ...f, gender: g.value }))}
                          disabled={busy}
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 카드 밖 · 유리 위. 메시지와 제출은 어느 묶음에도 속하지 않는다(폼 전체에 대한 것). */}
            <div className="auth-foot">
              {/* 자동 로그아웃 사유. 입력 오류(err)와 구분해서 보여준다(S15P11E101-508) */}
              {!err && logoutReason && REASON_TEXT[logoutReason] && (
                <div className="form-msg warn" id="logoutReason">{REASON_TEXT[logoutReason]}</div>
              )}
              {err && <div className="form-msg err">{err}</div>}
              <button type="submit" className="auth-submit" disabled={busy}>
                {busy ? '처리 중…' : mode === 'login' ? '로그인' : '회원가입'}
              </button>
              {/* 안내문은 모드까지 봐야 한다(S15P11E101-802). 로그인 모드 문구는 지웠다
                  [사용자 지침 2026-08-08] — 남길 문구가 없으므로 회원가입에서만 렌더한다. */}
              {mode === 'signup' && (
                <div className="auth-hint">가입한 계정으로 바로 로그인할 수 있습니다.</div>
              )}
              {/* 아이디/비밀번호 찾기 — 로그인 화면에서만 진입한다. */}
              {mode === 'login' && (
                <div className="auth-links">
                  <button type="button" onClick={() => switchMode('find-id')} disabled={busy}>아이디 찾기</button>
                  <span aria-hidden="true">·</span>
                  <button type="button" onClick={() => switchMode('reset-pw')} disabled={busy}>비밀번호 찾기</button>
                </div>
              )}
            </div>
          </form>
        )}
        {onBack && (
          <button type="button" className="auth-back" onClick={() => { reset(); onBack() }} disabled={busy}>← 처음으로</button>
        )}
      </div>
    </div>
  )
}
