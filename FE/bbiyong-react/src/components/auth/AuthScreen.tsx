import { errMessage, errStatus } from '../../live/errors.ts'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import { getDataSource, saveDataSource } from '../../live/config.ts'
import { GENDERS, formatPhone, validateSignup, todayISO, MIN_BIRTH_ISO } from '../../auth/signupRules.ts'
import { REASON_TEXT } from '../../auth/sessionPolicy.ts'

// 로그인 / 회원가입 게이트 (로그아웃 상태에서 표시)
//
// 실서버 모드는 §2 REST로 로그인해 accessToken을 확보한다. 이 토큰이 STOMP CONNECT에도
// 실리므로(§1), 어느 모드로 로그인했는지가 이후 실시간 연동 가능 여부를 결정한다.
// → 모드 선택을 로그인 화면에 함께 둔다.
const EMPTY = { email: '', password: '', password2: '', name: '', phone: '', birth: '', gender: '' }

/** @param {{ onBack?: (() => void) | null }} props */
export default function AuthScreen({ onBack }: { onBack?: (() => void) | null }) {
  const { login, signup, logoutReason } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [form, setForm] = useState(EMPTY)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState(getDataSource)
  const live = source === 'live'

  const reset = useCallback(() => { setForm(EMPTY); setErr('') }, [])

  const set = (k: any) => (e: any) => setForm((f) => ({ ...f, [k]: e.target.value }))
  // 휴대전화번호는 입력하는 대로 하이픈을 넣는다(숫자 외 문자는 버린다)
  const setPhone = (e: any) => setForm((f) => ({ ...f, phone: formatPhone(e.target.value) }))

  const switchMode = (m: any) => { setMode(m); reset() }
  const switchSource = (v: any) => {
    if (v === source) return
    // 실서버와 시뮬레이션은 계정 저장소가 다르다. 이전 모드의 개인정보·비밀번호를
    // 다음 모드로 들고 가지 않도록, 전환 시 전체 입력을 비운다.
    saveDataSource(v); setSource(v); reset()
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
      <div className="auth-card">
        <div className="auth-brand">삐용(BBIYONG)<span> 통합 관제 시스템</span></div>
        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => switchMode('login')} disabled={busy}>로그인</button>
          <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => switchMode('signup')} disabled={busy}>회원가입</button>
        </div>
        <div className="auth-source">
          <button type="button" className={!live ? 'on' : ''} onClick={() => switchSource('mock')} disabled={busy}>시뮬레이션</button>
          <button type="button" className={live ? 'on' : ''} onClick={() => switchSource('live')} disabled={busy}>실서버</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <div className="form-row">
              <label htmlFor="su-name">이름</label>
              <input id="su-name" value={form.name} onChange={set('name')} placeholder="관리자 이름" autoComplete="name" disabled={busy} />
            </div>
          )}
          <div className="form-row">
            <label htmlFor="au-email">이메일</label>
            <input id="au-email" type="email" value={form.email} onChange={set('email')} placeholder="safety@bbiyong.io" autoComplete="username" disabled={busy} />
          </div>
          <div className="form-row">
            <label htmlFor="au-pw">비밀번호</label>
            <input id="au-pw" type="password" value={form.password} onChange={set('password')} placeholder={mode === 'signup' ? '영문·숫자·특수문자 포함 8자 이상' : '비밀번호'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} disabled={busy} />
          </div>
          {mode === 'signup' && (
            <>
              <div className="form-row">
                <label htmlFor="su-pw2">비밀번호 확인</label>
                <input id="su-pw2" type="password" value={form.password2} onChange={set('password2')} placeholder="비밀번호 확인" autoComplete="new-password" disabled={busy} />
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
            </>
          )}
          {/* 자동 로그아웃 사유. 입력 오류(err)와 구분해서 보여준다(S15P11E101-508) */}
          {!err && logoutReason && REASON_TEXT[logoutReason] && (
            <div className="form-msg warn" id="logoutReason">{REASON_TEXT[logoutReason]}</div>
          )}
          {err && <div className="form-msg err">{err}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? '처리 중…' : mode === 'login' ? '로그인' : '회원가입'}
          </button>
        </form>
        <div className="auth-hint">
          {live
            ? '실서버 계정으로 로그인합니다 — 없으면 회원가입 후 이용하세요.'
            : '데모 계정 — safety@bbiyong.io / bbiyong'}
        </div>
        {onBack && (
          <button type="button" className="auth-back" onClick={() => { reset(); onBack() }} disabled={busy}>← 처음으로</button>
        )}
      </div>
    </div>
  )
}
