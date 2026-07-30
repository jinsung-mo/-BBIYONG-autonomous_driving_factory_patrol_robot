import { createContext, useContext, useState } from 'react'
import {
  addUser, clearSession, findUser, getSession, setSession, updateUser,
  getAuth, setAuth, clearToken,
} from './authStore.js'
import { getDataSource } from '../live/config.js'
import { loginRequest, signupRequest } from '../live/authApi.js'
import { phoneDigits } from './signupRules.js'

// mock 모드: localStorage 목 저장소로 인증 흐름만 재현.
// live 모드: 실서버 REST(§2)로 로그인하고 accessToken을 보관한다.
//            이 토큰은 STOMP CONNECT 헤더에도 실린다 — 없으면 실시간 연결이 거부된다(§1).

const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

// 비밀번호를 제외한 공개 유저 정보
const publicUser = (u) => (u ? { email: u.email, name: u.name, role: u.role } : null)

// 서버는 role만 내려준다 — 이름은 가입 시 입력값, 없으면 이메일 로컬파트로 채운다.
const roleLabel = (role) => (role === 'ROLE_ADMIN' ? '관제 권한' : role || '관제 권한')

function restoreUser() {
  const saved = getAuth()
  if (saved?.accessToken && saved.user) return { user: saved.user, accessToken: saved.accessToken }
  const s = getSession()
  return { user: s ? publicUser(findUser(s.email)) : null, accessToken: null }
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(restoreUser)
  const { user, accessToken } = state

  const login = async (email, password) => {
    if (getDataSource() !== 'live') {
      const u = findUser(email)
      if (!u || u.password !== password) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.')
      setSession(u.email)
      setState({ user: publicUser(u), accessToken: null })
      return
    }
    const res = await loginRequest(email.trim().toLowerCase(), password)
    if (!res?.accessToken) throw new Error('로그인 응답에 accessToken이 없습니다.')
    const nu = { email: email.trim().toLowerCase(), name: email.split('@')[0], role: roleLabel(res.role) }
    setAuth({ accessToken: res.accessToken, user: nu })
    setState({ user: nu, accessToken: res.accessToken })
  }

  // 휴대전화번호·생년월일·성별은 S15P11E101-493 에서 추가됐다.
  // 서버 /api/auth/signup 스키마에는 아직 없어 지금은 전송돼도 무시된다(BE 반영 후 저장).
  // 시뮬 모드는 localStorage 라 곧바로 저장된다.
  const signup = async ({ email, password, name, phone, birth, gender }) => {
    // 화면은 하이픈으로 보여주고 저장·전송은 숫자만 한다 — 이 경계에서 한 번만 정규화한다
    const tel = phoneDigits(phone)
    if (getDataSource() !== 'live') {
      const u = addUser({ email, password, name, phone: tel, birth, gender })
      setSession(u.email)
      setState({ user: publicUser(u), accessToken: null })
      return
    }
    await signupRequest({ email: email.trim().toLowerCase(), password, name, phone: tel, birth, gender })
    // 가입 직후 바로 로그인해 토큰을 확보한다
    const res = await loginRequest(email.trim().toLowerCase(), password)
    const nu = { email: email.trim().toLowerCase(), name, role: roleLabel(res?.role) }
    setAuth({ accessToken: res.accessToken, user: nu })
    setState({ user: nu, accessToken: res.accessToken })
  }

  const logout = () => { clearSession(); clearToken(); setState({ user: null, accessToken: null }) }

  // 아래 두 기능은 실서버 API 계약에 없다 — mock 모드에서만 동작한다.
  const changePassword = (current, next) => {
    if (accessToken) throw new Error('실서버 모드에서는 비밀번호 변경을 지원하지 않습니다.')
    const s = getSession(); const u = findUser(s?.email)
    if (!u || u.password !== current) throw new Error('현재 비밀번호가 올바르지 않습니다.')
    updateUser(u.email, { password: next })
  }

  const updateProfile = (patch) => {
    if (accessToken) throw new Error('실서버 모드에서는 프로필 수정을 지원하지 않습니다.')
    const s = getSession(); const u = updateUser(s.email, patch)
    setState((prev) => ({ ...prev, user: publicUser(u) }))
  }

  return (
    <AuthContext.Provider value={{ user, accessToken, login, signup, logout, changePassword, updateProfile }}>
      {children}
    </AuthContext.Provider>
  )
}
