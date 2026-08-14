import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  addUser, clearSession, findUser, getSession, setSession, updateUser,
  getAuth, setAuth, clearToken,
} from './authStore.ts'
import { getDataSource } from '../live/config.ts'
import {
  loginRequest, signupRequest, setUnauthorizedHandler, setAuthBridge, refreshAccessToken,
} from '../live/authApi.ts'
import { phoneDigits } from './signupRules.ts'
import { isAdminRole, ROLE_VIEWER } from './roles.ts'
import {
  REASON, refreshMargin, absoluteRemaining, idleRemaining, readActivity, writeActivity,
  readLockedAt, writeLockedAt, clearLockedAt, lockRemaining,
} from './sessionPolicy.ts'

// mock 모드: localStorage 목 저장소로 인증 흐름만 재현.
// live 모드: 실서버 REST(§2)로 로그인하고 accessToken을 보관한다.
//            이 토큰은 STOMP CONNECT 헤더에도 실린다 — 없으면 실시간 연결이 거부된다(§1).

/** @type {import('react').Context<import('../live/contracts').AuthContextValue | null>} */
const AuthContext = createContext<import('../live/contracts.d.ts').AuthContextValue | null>(null)

/**
 * Provider 밖에서 부르면 던지므로 호출부는 null 을 다룰 필요가 없다 —
 * 반환 타입을 non-null 로 좁혀 매번 옵셔널 체이닝을 쓰지 않게 한다(S15P11E101-570).
 */
// 로그인하면 지도에서 시작한다(S15P11E101-803).
// App 은 sessionStorage 의 마지막 화면을 복원한다. 새로고침 때 보던 화면을 지키려는
// 것인데, 새로 접속한 사람에게까지 앞사람의 마지막 화면(설정)을 보여 줄 이유는 없다.
// 관제의 첫 화면은 지도다 — 로봇이 어디 있는지가 먼저다.
// 토큰 갱신에는 걸지 않는다. 갱신은 로그인이 아니라서, 거기 걸면 작업 중에
// 화면이 제멋대로 지도로 튄다.
const startAtMap = () => {
  try { sessionStorage.setItem('section', 'live') } catch { /* 저장소가 막힌 환경 */ }
}

export function useAuth(): import('../live/contracts.d.ts').AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

// 비밀번호를 제외한 공개 유저 정보
/**
 * @param {import('../live/contracts').StoredUser | null | undefined} u
 * @returns {import('../live/contracts').PublicUser | null}
 */
const publicUser = (u: any) => (u ? { email: u.email, name: u.name, role: u.role } : null)

// 서버는 role만 내려준다 — 이름은 가입 시 입력값, 없으면 이메일 로컬파트로 채운다.
// 서버가 준 role 원문을 그대로 보관한다 — 표시 문구로 바꿔 저장하면 권한 판정을 잃는다.
/** @param {string | null | undefined} role */
const rawRole = (role: any) => role || ROLE_VIEWER

/**
 * 세션 상태. restoreUser() 가 만드는 형태와 이후 setState 가 넣는 형태가 갈라져 있었다 —
 * reason 을 빠뜨린 호출이 다섯 군데였다(@types/react 를 넣으니 드러났다).
 */
type SessionState = {
  user: import('../live/contracts').PublicUser | null
  accessToken: string | null
  /** access 재발급용(S15P11E101-613). 서버가 주지 않으면 null 이고, 그때는 갱신하지 않는다. */
  refreshToken: string | null
  expiresAt: number | null
  reason: import('../live/contracts').LogoutReason | null
}

// 복원 전에 만료를 먼저 판정한다(S15P11E101-508). 지난 세션은 되살리지 않는다 —
// 브라우저를 닫았다 다시 열어도, 유휴 시간이 지났으면 로그인 화면으로 보낸다.
function restoreUser(): SessionState {
  const saved = getAuth()
  const s = getSession()
  const hasSession = !!(saved?.accessToken && saved.user) || !!s
  const empty = { user: null, accessToken: null, refreshToken: null, expiresAt: null }

  if (!hasSession) return { ...empty, reason: null }

  // refresh 토큰이 있으면 access 가 만료됐어도 세션은 살아 있다 — 곧 갱신 타이머가 살려낸다.
  // 갱신 수단이 없을 때만 예전처럼 만료로 끊는다(S15P11E101-613).
  if (!saved?.refreshToken && absoluteRemaining(saved?.expiresAt) <= 0) {
    clearSession()
    return { ...empty, reason: REASON.EXPIRED }
  }
  // 유휴로는 더 이상 세션을 끊지 않는다(S15P11E101-653) — 조작만 잠근다.
  // 다만 잠긴 채로 상한(12시간)을 넘겼으면 그때는 되살리지 않는다. 근무가 교대됐다는 뜻이다.
  if (lockRemaining() <= 0) {
    clearSession(); clearLockedAt()
    return { ...empty, reason: REASON.IDLE }
  }

  if (saved?.accessToken && saved.user) {
    return {
      user: saved.user, accessToken: saved.accessToken,
      refreshToken: saved.refreshToken ?? null,
      expiresAt: saved.expiresAt ?? null, reason: null,
    }
  }
  return { ...empty, user: publicUser(findUser(s.email)), reason: null }
}

// 로그인 응답의 expiresIn(초) → 절대 만료 시각. 값이 없으면 절대 만료를 걸지 않는다
// (유휴 만료는 그대로 동작한다).
/** @param {{ expiresIn?: number } | null | undefined} res */
const expiryFrom = (res: any) => (Number(res?.expiresIn) > 0 ? Date.now() + Number(res.expiresIn) * 1000 : null)

export function AuthProvider({ children }: { children?: import('react').ReactNode }) {
  const [state, setState] = useState<SessionState>(restoreUser)
  const { user, accessToken, refreshToken, expiresAt } = state
  // restoreUser() 는 만료를 발견하면 세션을 지운다 — 두 번 부르면 두 번째는 사유를 잃는다.
  // 최초 판정 결과를 그대로 쓴다.
  const [logoutReason, setLogoutReason] = useState(state.reason ?? null)
  // 조작 잠금(S15P11E101-653). 세션은 살아 있고 화면도 그대로 흐른다 — 조작만 막힌다.
  //
  // 시작 상태를 저장소에서 읽어 새로고침을 견딘다. 이때 '이미 잠겼는가' 만 보면
  // 빈틈이 생긴다 — 브라우저를 닫아 둔 사이 유휴가 지났다면, 다시 열었을 때 아직 잠금
  // 기록이 없어 판정 주기(5초)가 돌 때까지 조작이 열린 채로 있다. 그 5초가 자리를 비운
  // 사이 누가 만지는 것을 막자는 취지를 그대로 무너뜨린다. 첫 렌더에서 함께 판정한다.
  const [locked, setLocked] = useState(() => {
    if (readLockedAt() > 0) return true
    if (readActivity() && idleRemaining() <= 0) { writeLockedAt(); return true }
    return false
  })

  const login = async (email: any, password: any) => {
    writeActivity()
    if (getDataSource() !== 'live') {
      const u = findUser(email)
      if (!u || u.password !== password) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.')
      setSession(u.email)
      setLogoutReason(null); unlockState()
      startAtMap(); setState({ user: publicUser(u), accessToken: null, refreshToken: null, expiresAt: null, reason: null })
      return
    }
    const res = await loginRequest(email.trim().toLowerCase(), password)
    if (!res?.accessToken) throw new Error('로그인 응답에 accessToken이 없습니다.')
    const nu = { email: email.trim().toLowerCase(), name: email.split('@')[0], role: rawRole(res.role) }
    const exp = expiryFrom(res)
    const rt = res.refreshToken ?? null
    setAuth({ accessToken: res.accessToken, user: nu, refreshToken: rt, expiresAt: exp, expiresIn: res.expiresIn ?? null })
    setLogoutReason(null); unlockState()
    startAtMap(); setState({ user: nu, accessToken: res.accessToken, refreshToken: rt, expiresAt: exp, reason: null })
  }

  // 휴대전화번호·생년월일·성별은 S15P11E101-493 에서 추가됐다.
  // 서버 /api/auth/signup 스키마에는 아직 없어 지금은 전송돼도 무시된다(BE 반영 후 저장).
  // 시뮬 모드는 localStorage 라 곧바로 저장된다.
  const signup = async ({ email, password, name, phone, birth, gender }: {
    email: string, password: string, name?: string,
    phone?: string, birth?: string, gender?: string,
  }) => {
    // 화면은 하이픈으로 보여주고 저장·전송은 숫자만 한다 — 이 경계에서 한 번만 정규화한다
    const tel = phoneDigits(phone)
    writeActivity()
    if (getDataSource() !== 'live') {
      const u = addUser({ email, password, name, phone: tel, birth, gender })
      setSession(u.email)
      setLogoutReason(null); unlockState()
      startAtMap(); setState({ user: publicUser(u), accessToken: null, refreshToken: null, expiresAt: null, reason: null })
      return
    }
    await signupRequest({ email: email.trim().toLowerCase(), password, name, phone: tel, birth, gender })
    // 가입 직후 바로 로그인해 토큰을 확보한다
    const res = await loginRequest(email.trim().toLowerCase(), password)
    const nu = { email: email.trim().toLowerCase(), name, role: rawRole(res?.role) }
    const exp = expiryFrom(res)
    const rt = res?.refreshToken ?? null
    setAuth({ accessToken: res.accessToken, user: nu, refreshToken: rt, expiresAt: exp, expiresIn: res?.expiresIn ?? null })
    setLogoutReason(null); unlockState()
    startAtMap(); setState({ user: nu, accessToken: res.accessToken, refreshToken: rt, expiresAt: exp, reason: null })
  }

  // 잠금 해제 — 저장소와 화면 상태를 함께 되돌린다. 활동 시각도 지금으로 밀어
  // 풀자마자 다시 잠기지 않게 한다.
  const unlockState = useCallback(() => {
    clearLockedAt()
    lastWrite.current = Date.now()
    writeActivity(lastWrite.current)
    setLocked(false)
  }, [])

  // reason 이 MANUAL 이면 안내를 띄우지 않는다 — 스스로 누른 로그아웃이다.
  const logout = useCallback((reason: import('../live/contracts').LogoutReason = REASON.MANUAL) => {
    clearSession(); clearToken(); clearLockedAt()
    setLocked(false)
    setLogoutReason(reason === REASON.MANUAL ? null : reason)
    setState({ user: null, accessToken: null, refreshToken: null, expiresAt: null, reason: null })
  }, [])

  // 활동 기록. 사용자 조작과 이벤트 로그 신규 기록이 모두 여기로 들어온다.
  // localStorage 쓰기라 잦은 호출(마우스 이동)을 대비해 10초 간격으로 눌러 준다.
  //
  // 잠긴 뒤에는 활동을 기록하지 않는다. 잠긴 화면 위에서 마우스를 움직이거나 이벤트가
  // 기록됐다고 잠금이 풀리면, 비밀번호를 묻는 의미가 없다.
  const lastWrite = useRef(0)
  const touch = useCallback(() => {
    if (readLockedAt() > 0) return
    const now = Date.now()
    if (now - lastWrite.current < 10_000) return
    lastWrite.current = now
    writeActivity(now)
  }, [])

  // 갱신 결과를 저장소·상태에 함께 반영한다(S15P11E101-613).
  // 서버가 refreshToken 을 회전시켜 새로 주므로 그것도 갈아 끼운다 — 예전 것을 남겨 두면
  // 다음 갱신이 죽은 토큰으로 나간다.
  const applyRefreshed = useCallback((res: any) => {
    const exp = expiryFrom(res)
    const rt = res?.refreshToken ?? getAuth()?.refreshToken ?? null
    setState((prev) => {
      if (!prev.user) return prev            // 그 사이 로그아웃했으면 되살리지 않는다
      setAuth({ accessToken: res.accessToken, user: prev.user, refreshToken: rt, expiresAt: exp, expiresIn: res?.expiresIn ?? null })
      // 서버가 role 을 함께 준다 — 승격·강등이 다음 갱신에 반영된다(S15P11E101-614 대비)
      const user2 = res?.role ? { ...prev.user, role: rawRole(res.role) } : prev.user
      return { ...prev, user: user2, accessToken: res.accessToken, refreshToken: rt, expiresAt: exp }
    })
  }, [])

  // authApi 는 리액트 상태를 모른다 — refresh 토큰을 읽고 결과를 돌려줄 다리를 놓는다.
  // 저장소에서 읽는다: 다른 탭이 갱신했을 수도 있고, 이 콜백이 낡은 상태를 붙들면 안 된다.
  useEffect(() => {
    setAuthBridge({
      getRefreshToken: () => getAuth()?.refreshToken ?? null,
      onRefreshed: applyRefreshed,
    })
    return () => setAuthBridge(null)
  }, [applyRefreshed])

  // 만료 감시. setTimeout 대신 짧은 주기로 확인한다 — 절전/최대 절전으로 타이머가
  // 밀려도 깨어난 직후 실제 경과 시간으로 판정된다.
  const refreshing = useRef(false)
  useEffect(() => {
    if (!user) return undefined
    const tick = () => {
      // 다른 탭에서 로그아웃했으면 이 탭도 따라 나간다
      if (accessToken && !getAuth()?.accessToken) { logout(REASON.EXPIRED); return }
      if (!accessToken && !getSession()) { logout(REASON.MANUAL); return }

      // 다른 탭이 갱신했으면 그 결과를 그대로 받아 쓴다(S15P11E101-626).
      // 각 탭이 따로 갱신하면 서버가 refresh 를 회전시키는 만큼 서로의 토큰을 무효로 만들고,
      // 이 탭의 STOMP 는 낡은 access 로 붙어 있게 된다. 저장소가 유일한 진실이다.
      const saved = getAuth()
      if (saved?.accessToken && saved.accessToken !== accessToken) {
        setState((prev) => (prev.user ? {
          ...prev,
          user: saved.user ?? prev.user,   // 승격·강등도 함께 따라온다
          accessToken: saved.accessToken,
          refreshToken: saved.refreshToken ?? null,
          expiresAt: saved.expiresAt ?? null,
        } : prev))
        return
      }

      // access 만료가 가까우면 미리 갱신한다. 갱신 수단이 없으면(구버전 서버) 예전처럼 끊는다.
      const untilExpiry = absoluteRemaining(expiresAt)
      if (refreshToken && untilExpiry <= refreshMargin(getAuth()?.expiresIn) && !refreshing.current) {
        refreshing.current = true
        refreshAccessToken()
          .then((next) => { if (!next) logout(REASON.EXPIRED) })
          .finally(() => { refreshing.current = false })
        return
      }
      if (!refreshToken && untilExpiry <= 0) { logout(REASON.EXPIRED); return }

      // 유휴가 지나면 끊지 않고 잠근다(S15P11E101-653). 화면은 계속 흐르고 STOMP 도 살아 있다 —
      // 무인 시간대에 감시가 끊기면 안 되고, 로그아웃되면 긴급 정지조차 누를 수 없다.
      const lockedAt = readLockedAt()
      if (!lockedAt) {
        if (idleRemaining() <= 0) { writeLockedAt(); setLocked(true) }
        return
      }
      // 다른 탭에서 잠갔으면 이 탭도 따라 잠근다
      setLocked(true)
      // 잠긴 채로 상한을 넘기면 그때는 실제로 로그아웃한다 — 근무는 교대된다.
      if (lockRemaining() <= 0) logout(REASON.IDLE)
    }
    tick()
    const id = setInterval(tick, 5000)
    // 다른 탭의 활동·로그아웃을 즉시 반영한다(5초를 기다리지 않는다)
    const onStorage = () => tick()
    window.addEventListener('storage', onStorage)
    return () => { clearInterval(id); window.removeEventListener('storage', onStorage) }
  }, [user, accessToken, refreshToken, expiresAt, logout])

  // 활동 기록이 없는 채로 로그인 상태가 복원되면(배포 직후 등) 지금을 기준으로 시작한다
  useEffect(() => { if (user && !readActivity()) writeActivity() }, [user])

  // REST 401 — 여기까지 왔다는 것은 authApi 가 이미 갱신을 시도했고 실패했다는 뜻이다
  // (성공했으면 재시도가 통과해 이 핸들러가 불리지 않는다). 그러니 곧바로 로그인으로 보낸다.
  // 403 은 권한 문제라 authApi 가 이 핸들러를 부르지 않는다(S15P11E101-613).
  useEffect(() => {
    setUnauthorizedHandler(() => { if (accessToken) logout(REASON.EXPIRED) })
    return () => setUnauthorizedHandler(null)
  }, [accessToken, logout])

  // 서버가 권한을 거절했다(403). 화면은 관리자로 알고 있는데 서버는 아니라는 뜻이므로,
  // 갱신을 한 번 돌려 서버가 판단한 role 을 받아 온다 — refresh 응답에 role 이 실려 있다.
  // 이렇게 하지 않으면 강등된 관리자가 다음 정기 갱신(최대 1시간)까지 관리자 메뉴를 계속 본다.
  const syncRole = useCallback(async () => {
    if (!accessToken) return
    await refreshAccessToken()
  }, [accessToken])

  // 잠금 해제 — 비밀번호를 다시 확인한다(S15P11E101-653).
  //
  // 실서버에는 '비밀번호만 확인' 엔드포인트가 없어 로그인 API 를 다시 부른다. 성공하면
  // 새 토큰까지 함께 오므로 세션이 오히려 신선해진다. 다만 그 사이 강등됐을 수 있으니
  // 응답의 role 을 그대로 반영한다 — 잠금을 푸는 김에 권한도 최신으로 맞춘다.
  //
  // 실패해도 잠금을 유지할 뿐 로그아웃하지 않는다. 야간 무인 시간대에 오타 한 번으로
  // 관제 화면이 로그인 폼이 되면 그게 더 위험하다. 시도 횟수도 제한하지 않는다.
  const unlock = useCallback(async (password: string) => {
    const email = user?.email
    if (!email) throw new Error('로그인 정보가 없습니다.')
    if (getDataSource() !== 'live') {
      const u = findUser(email)
      if (!u || u.password !== password) throw new Error('비밀번호가 올바르지 않습니다.')
      unlockState()
      return
    }
    const res = await loginRequest(email, password)
    if (!res?.accessToken) throw new Error('비밀번호가 올바르지 않습니다.')
    const exp = expiryFrom(res)
    const rt = res.refreshToken ?? getAuth()?.refreshToken ?? null
    const nu = { ...user, role: rawRole(res.role) }
    setAuth({ accessToken: res.accessToken, user: nu, refreshToken: rt, expiresAt: exp, expiresIn: res.expiresIn ?? null })
    setState((prev) => (prev.user
      ? { ...prev, user: nu, accessToken: res.accessToken, refreshToken: rt, expiresAt: exp }
      : prev))
    unlockState()
  }, [user, unlockState])

  // 아래 두 기능은 실서버 API 계약에 없다 — mock 모드에서만 동작한다.
  const changePassword = (current: any, next: any) => {
    if (accessToken) throw new Error('실서버 모드에서는 비밀번호 변경을 지원하지 않습니다.')
    const s = getSession(); const u = findUser(s?.email)
    if (!u || u.password !== current) throw new Error('현재 비밀번호가 올바르지 않습니다.')
    updateUser(u.email, { password: next })
  }

  const updateProfile = (patch: any) => {
    if (accessToken) throw new Error('실서버 모드에서는 프로필 수정을 지원하지 않습니다.')
    const s = getSession(); const u = updateUser(s.email, patch)
    setState((prev) => ({ ...prev, user: publicUser(u) }))
  }

  return (
    <AuthContext.Provider value={{
      user, accessToken, login, signup, logout, changePassword, updateProfile,
      isAdmin: isAdminRole(user?.role),
      // 조작해도 되는가 — 권한이 있고, 잠기지 않았을 때만(S15P11E101-653).
      // isAdmin 은 '무엇을 보여 줄지'에, canOperate 는 '무엇을 누르게 할지'에 쓴다.
      // 잠겼다고 탭이나 패널을 감추지 않는다 — 감시 화면은 계속 보여야 한다.
      canOperate: isAdminRole(user?.role) && !locked,
      syncRole,
      touch, logoutReason, clearLogoutReason: () => setLogoutReason(null),
      // 조작 잠금(S15P11E101-653). 뷰어는 애초에 조작 권한이 없으므로 잠금과 무관하다.
      locked, unlock, lockNow: () => { writeLockedAt(); setLocked(true) },
    }}>
      {children}
    </AuthContext.Provider>
  )
}
