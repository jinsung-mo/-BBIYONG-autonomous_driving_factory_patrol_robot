import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { addUser, clearSession, findUser, getSession, setSession, updateUser } from './authStore'
import type { AuthContextValue, StoredUser, User } from '../types'

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

// 비밀번호를 제외한 공개 유저 정보
const publicUser = (u: StoredUser | undefined | null): User | null =>
  (u ? { email: u.email, name: u.name, role: u.role } : null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const s = getSession()
    return s ? publicUser(findUser(s.email)) : null
  })

  const login = (email: string, password: string) => {
    const u = findUser(email)
    if (!u || u.password !== password) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.')
    setSession(u.email); setUser(publicUser(u))
  }

  const signup = ({ email, password, name }: { email: string; password: string; name: string }) => {
    const u = addUser({ email, password, name })
    setSession(u.email); setUser(publicUser(u))
  }

  const logout = () => { clearSession(); setUser(null) }

  const changePassword = (current: string, next: string) => {
    const s = getSession(); const u = findUser(s?.email)
    if (!u || u.password !== current) throw new Error('현재 비밀번호가 올바르지 않습니다.')
    updateUser(u.email, { password: next })
  }

  const updateProfile = (patch: Partial<Pick<User, 'name' | 'role'>>) => {
    const s = getSession(); const u = updateUser(s!.email, patch)
    setUser(publicUser(u))
  }

  return (
    <AuthContext.Provider value={{ user, login, signup, logout, changePassword, updateProfile }}>
      {children}
    </AuthContext.Provider>
  )
}
