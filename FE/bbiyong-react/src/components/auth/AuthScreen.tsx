import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext'

type Mode = 'login' | 'signup'

// 로그인 / 회원가입 게이트 (로그아웃 상태에서 표시)
export default function AuthScreen({ onBack }: { onBack?: () => void }) {
  const { login, signup } = useAuth()
  const [mode, setMode] = useState<Mode>('login') // 'login' | 'signup'
  const [form, setForm] = useState({ email: '', password: '', password2: '', name: '' })
  const [err, setErr] = useState('')

  const set = (k: 'email' | 'password' | 'password2' | 'name') => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = (e: FormEvent) => {
    e.preventDefault(); setErr('')
    try {
      if (mode === 'login') {
        login(form.email.trim(), form.password)
      } else {
        if (!form.name.trim()) throw new Error('이름을 입력하세요.')
        if (!form.email.trim()) throw new Error('이메일을 입력하세요.')
        if (form.password.length < 4) throw new Error('비밀번호는 4자 이상이어야 합니다.')
        if (form.password !== form.password2) throw new Error('비밀번호가 일치하지 않습니다.')
        signup({ email: form.email.trim(), password: form.password, name: form.name.trim() })
      }
    } catch (e2) { setErr((e2 as Error).message) }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">삐용(BBIYONG)<span> 통합 관제 시스템</span></div>
        <div className="auth-tabs">
          <button className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr('') }}>로그인</button>
          <button className={mode === 'signup' ? 'on' : ''} onClick={() => { setMode('signup'); setErr('') }}>회원가입</button>
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
          <button type="submit" className="auth-submit">{mode === 'login' ? '로그인' : '회원가입'}</button>
        </form>
        <div className="auth-hint">데모 계정 — safety@bbiyong.io / bbiyong</div>
        {onBack && (
          <button type="button" className="auth-back" onClick={onBack}>← 처음으로</button>
        )}
      </div>
    </div>
  )
}
