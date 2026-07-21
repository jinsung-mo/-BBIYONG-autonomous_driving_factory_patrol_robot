import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.jsx'

export default function AuthScreen({ onBack }) {
  const { login } = useAuth()
  const [form, setForm] = useState({ username: '', password: '' })
  const [err, setErr] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

  const submit = async (event) => {
    event.preventDefault()
    setErr('')
    setSubmitting(true)
    try {
      await login(form.username.trim(), form.password)
    } catch (error) {
      setErr(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">삐용(BBIYONG)<span> 통합 관제 시스템</span></div>
        <div className="auth-tabs">
          <button className="on" type="button">로그인</button>
          <button type="button">회원가입</button>
        </div>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>관리자 아이디</label>
            <input value={form.username} onChange={set('username')} placeholder="admin01" autoComplete="username" required />
          </div>
          <div className="form-row">
            <label>비밀번호</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder="비밀번호" autoComplete="current-password" required />
          </div>
          {err && <div className="form-msg err">{err}</div>}
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? '로그인 중...' : '로그인'}
          </button>
        </form>
        <div className="auth-hint">테스트 관리자 계정: admin01 / password123!</div>
        {onBack && <button type="button" className="auth-back" onClick={onBack}>← 처음으로</button>}
      </div>
    </div>
  )
}
