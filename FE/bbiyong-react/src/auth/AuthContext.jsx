import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  addUser, clearSession, findUser, getSession, setSession, updateUser,
  getAuth, setAuth, clearToken,
} from './authStore.js'
import { getDataSource } from '../live/config.js'
import { loginRequest, signupRequest, setUnauthorizedHandler } from '../live/authApi.js'
import { phoneDigits } from './signupRules.js'
import { isAdminRole, ROLE_VIEWER } from './roles.js'
import {
  REASON, WARN_MS, absoluteRemaining, idleRemaining, readActivity, writeActivity,
} from './sessionPolicy.js'

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
// 서버가 준 role 원문을 그대로 보관한다 — 표시 문구로 바꿔 저장하면 권한 판정을 잃는다.
const rawRole = (role) => role || ROLE_VIEWER

// 복원 전에 만료를 먼저 판정한다(S15P11E101-508). 지난 세션은 되살리지 않는다 —
// 브라우저를 닫았다 다시 열어도, 유휴 시간이 지났으면 로그인 화면으로 보낸다.
function restoreUser() {
  const saved = getAuth()
  const s = getSession()
  const hasSession = !!(saved?.accessToken && saved.user) || !!s
  if (!hasSession) return { user: null, accessToken: null, expiresAt: null, reason: null }

  if (absoluteRemaining(saved?.expiresAt) <= 0) {
    clearSession()
    return { user: null, accessToken: null, expiresAt: null, reason: REASON.EXPIRED }
  }
  if (idleRemaining() <= 0) {
    clearSession()
    return { user: null, accessToken: null, expiresAt: null, reason: REASON.IDLE }
  }

  if (saved?.accessToken && saved.user) {
    return { user: saved.user, accessToken: saved.accessToken, expiresAt: saved.expiresAt ?? null, reason: null }
  }
  return { user: publicUser(findUser(s.email)), accessToken: null, expiresAt: null, reason: null }
}

// 로그인 응답의 expiresIn(초) → 절대 만료 시각. 값이 없으면 절대 만료를 걸지 않는다
// (유휴 만료는 그대로 동작한다).
const expiryFrom = (res) => (Number(res?.expiresIn) > 0 ? Date.now() + Number(res.expiresIn) * 1000 : null)

export function AuthProvider({ children }) {
  const [state, setState] = useState(restoreUser)
  const { user, accessToken, expiresAt } = state
  // restoreUser() 는 만료를 발견하면 세션을 지운다 — 두 번 부르면 두 번째는 사유를 잃는다.
  // 최초 판정 결과를 그대로 쓴다.
  const [logoutReason, setLogoutReason] = useState(state.reason ?? null)
  const [warning, setWarning] = useState(false)   // 만료 임박 경고 표시 여부

  const login = async (email, password) => {
    writeActivity()
    if (getDataSource() !== 'live') {
      const u = findUser(email)
      if (!u || u.password !== password) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.')
      setSession(u.email)
      setLogoutReason(null); setWarning(false)
      setState({ user: publicUser(u), accessToken: null, expiresAt: null })
      return
    }
    const res = await loginRequest(email.trim().toLowerCase(), password)
    if (!res?.accessToken) throw new Error('로그인 응답에 accessToken이 없습니다.')
    const nu = { email: email.trim().toLowerCase(), name: email.split('@')[0], role: rawRole(res.role) }
    const exp = expiryFrom(res)
    setAuth({ accessToken: res.accessToken, user: nu, expiresAt: exp })
    setLogoutReason(null); setWarning(false)
    setState({ user: nu, accessToken: res.accessToken, expiresAt: exp })
  }

  // 휴대전화번호·생년월일·성별은 S15P11E101-493 에서 추가됐다.
  // 서버 /api/auth/signup 스키마에는 아직 없어 지금은 전송돼도 무시된다(BE 반영 후 저장).
  // 시뮬 모드는 localStorage 라 곧바로 저장된다.
  const signup = async ({ email, password, name, phone, birth, gender }) => {
    // 화면은 하이픈으로 보여주고 저장·전송은 숫자만 한다 — 이 경계에서 한 번만 정규화한다
    const tel = phoneDigits(phone)
    writeActivity()
    if (getDataSource() !== 'live') {
      const u = addUser({ email, password, name, phone: tel, birth, gender })
      setSession(u.email)
      setLogoutReason(null); setWarning(false)
      setState({ user: publicUser(u), accessToken: null, expiresAt: null })
      return
    }
    await signupRequest({ email: email.trim().toLowerCase(), password, name, phone: tel, birth, gender })
    // 가입 직후 바로 로그인해 토큰을 확보한다
    const res = await loginRequest(email.trim().toLowerCase(), password)
    const nu = { email: email.trim().toLowerCase(), name, role: rawRole(res?.role) }
    const exp = expiryFrom(res)
    setAuth({ accessToken: res.accessToken, user: nu, expiresAt: exp })
    setLogoutReason(null); setWarning(false)
    setState({ user: nu, accessToken: res.accessToken, expiresAt: exp })
  }

  // reason 이 MANUAL 이면 안내를 띄우지 않는다 — 스스로 누른 로그아웃이다.
  const logout = useCallback((reason = REASON.MANUAL) => {
    clearSession(); clearToken()
    setWarning(false)
    setLogoutReason(reason === REASON.MANUAL ? null : reason)
    setState({ user: null, accessToken: null, expiresAt: null })
  }, [])

  // 활동 기록. 사용자 조작과 이벤트 로그 신규 기록이 모두 여기로 들어온다.
  // localStorage 쓰기라 잦은 호출(마우스 이동)을 대비해 10초 간격으로 눌러 준다.
  const lastWrite = useRef(0)
  const touch = useCallback(() => {
    const now = Date.now()
    if (now - lastWrite.current < 10_000) return
    lastWrite.current = now
    writeActivity(now)
    setWarning(false)
  }, [])

  // 경고 상태에서 '계속 사용' — 조금 전에 눌렀더라도 즉시 기록한다
  const extendSession = useCallback(() => {
    lastWrite.current = Date.now()
    writeActivity(lastWrite.current)
    setWarning(false)
  }, [])

  // 만료 감시. setTimeout 대신 짧은 주기로 확인한다 — 절전/최대 절전으로 타이머가
  // 밀려도 깨어난 직후 실제 경과 시간으로 판정된다.
  useEffect(() => {
    if (!user) return undefined
    const tick = () => {
      // 다른 탭에서 로그아웃했으면 이 탭도 따라 나간다
      if (accessToken && !getAuth()?.accessToken) { logout(REASON.EXPIRED); return }
      if (!accessToken && !getSession()) { logout(REASON.MANUAL); return }

      if (absoluteRemaining(expiresAt) <= 0) { logout(REASON.EXPIRED); return }
      const left = idleRemaining()
      if (left <= 0) { logout(REASON.IDLE); return }
      setWarning(left <= WARN_MS)
    }
    tick()
    const id = setInterval(tick, 5000)
    // 다른 탭의 활동·로그아웃을 즉시 반영한다(5초를 기다리지 않는다)
    const onStorage = () => tick()
    window.addEventListener('storage', onStorage)
    return () => { clearInterval(id); window.removeEventListener('storage', onStorage) }
  }, [user, accessToken, expiresAt, logout])

  // 활동 기록이 없는 채로 로그인 상태가 복원되면(배포 직후 등) 지금을 기준으로 시작한다
  useEffect(() => { if (user && !readActivity()) writeActivity() }, [user])

  // REST 401/403 — 토큰이 죽었다는 뜻이다. 화면에 남겨두지 않고 로그인으로 보낸다.
  useEffect(() => {
    setUnauthorizedHandler(() => { if (accessToken) logout(REASON.EXPIRED) })
    return () => setUnauthorizedHandler(null)
  }, [accessToken, logout])

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
    <AuthContext.Provider value={{
      user, accessToken, login, signup, logout, changePassword, updateProfile,
      isAdmin: isAdminRole(user?.role),
      touch, warning, extendSession, logoutReason, clearLogoutReason: () => setLogoutReason(null),
    }}>
      {children}
    </AuthContext.Provider>
  )
}
