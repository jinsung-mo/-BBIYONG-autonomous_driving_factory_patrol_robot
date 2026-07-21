import { createContext, useContext, useState } from 'react'
import { clearSession, getSession, setSession } from './authStore.js'

const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

function toUser(session) {
  if (!session?.username || !session?.accessToken) return null
  return { email: session.username, name: session.username, role: session.role }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => toUser(getSession()))

  const login = async (username, password) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

    if (!response.ok) {
      if (response.status === 401) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.')
      throw new Error('로그인 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.')
    }

    const result = await response.json()
    const session = { username, accessToken: result.accessToken, role: result.role }
    setSession(session)
    setUser(toUser(session))
  }

  const logout = () => { clearSession(); setUser(null) }
  const unsupported = () => { throw new Error('이 기능은 아직 지원하지 않습니다.') }

  return (
    <AuthContext.Provider value={{ user, login, logout, signup: unsupported, changePassword: unsupported, updateProfile: unsupported }}>
      {children}
    </AuthContext.Provider>
  )
}
