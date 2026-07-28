import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.jsx'
import { getDataSource, saveDataSource } from '../../live/config.js'

// 로그인 / 회원가입 게이트 (로그아웃 상태에서 표시)
//
// 실서버 모드는 §2 REST로 로그인해 accessToken을 확보한다. 이 토큰이 STOMP CONNECT에도
// 실리므로(§1), 어느 모드로 로그인했는지가 이후 실시간 연동 가능 여부를 결정한다.
// → 모드 선택을 로그인 화면에 함께 둔다.
export default function AuthScreen({ onBack }) {
  const { login, signup } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [form, setForm] = useState({ email: '', password: '', password2: '', name: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState(getDataSource)
  const live = source === 'live'

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const switchSource = (v) => { saveDataSource(v); setSource(v); setErr('') }

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      if (mode === 'login') {
        await login(form.email.trim(), form.password)
      } else {
        if (!form.name.trim()) throw new Error('이름을 입력하세요.')
        if (!form.email.trim()) throw new Error('이메일을 입력하세요.')
        if (form.password.length < 4) throw new Error('비밀번호는 4자 이상이어야 합니다.')
        if (form.password !== form.password2) throw new Error('비밀번호가 일치하지 않습니다.')
        await signup({ email: form.email.trim(), password: form.password, name: form.name.trim() })
      }
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">삐용(BBIYONG)<span> 통합 관제 시스템</span></div>
        <div className="auth-tabs">
          <button className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr('') }}>로그인</button>
          <button className={mode === 'signup' ? 'on' : ''} onClick={() => { setMode('signup'); setErr('') }}>회원가입</button>
        </div>
        <div className="auth-source">
          <button type="button" className={!live ? 'on' : ''} onClick={() => switchSource('mock')}>시뮬레이션</button>
          <button type="button" className={live ? 'on' : ''} onClick={() => switchSource('live')}>실서버</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <div className="form-row">
              <label>이름</label>
              <input value={form.name} onChange={set('name')} placeholder="관리자 이름" autoComplete="name" />
            </div>
          )}
          <div className="form-row">
            <label>이메일</label>
            <input type="email" value={form.email} onChange={set('email')} placeholder="safety@bbiyong.io" autoComplete="username" />
          </div>
          <div className="form-row">
            <label>비밀번호</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder="비밀번호" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </div>
          {mode === 'signup' && (
            <div className="form-row">
              <label>비밀번호 확인</label>
              <input type="password" value={form.password2} onChange={set('password2')} placeholder="비밀번호 확인" autoComplete="new-password" />
            </div>
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
          <button type="button" className="auth-back" onClick={onBack}>← 처음으로</button>
        )}
      </div>
    </div>
  )
}
