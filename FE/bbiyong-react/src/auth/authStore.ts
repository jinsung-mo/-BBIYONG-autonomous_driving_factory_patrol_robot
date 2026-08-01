// 목(mock) 회원 저장소 — localStorage 기반. 백엔드 없이 인증 흐름을 재현한다.
// 실제 배포 시 Spring 메인서버(FN-M01/M02) 인증으로 교체하는 것을 전제로 한 자리표시자.

import { ROLE_ADMIN, ROLE_VIEWER } from './roles.ts'
import { clearActivity } from './sessionPolicy.ts'

const USERS_KEY = 'bbiyong.users'
const SESSION_KEY = 'bbiyong.session'
const TOKEN_KEY = 'bbiyong.token'

// 데모용 기본 관리자 계정
// 데모용 기본 관리자 계정 — 시뮬 모드에서 운영/설정 탭까지 둘러볼 수 있게 관리자로 둔다.
const SEED = [{ email: 'safety@bbiyong.io', password: 'bbiyong', name: 'E101 관리자', role: ROLE_ADMIN }]

function readUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || 'null') } catch { return null }
}
function writeUsers(users: any) { localStorage.setItem(USERS_KEY, JSON.stringify(users)) }

/** @returns {import('../live/contracts').StoredUser[]} */
export function getUsers() {
  let users = readUsers()
  if (!Array.isArray(users) || users.length === 0) { users = SEED.slice(); writeUsers(users) }
  return users
}

/**
 * @param {string | null | undefined} email
 * @returns {import('../live/contracts').StoredUser | undefined}
 */
export function findUser(email: string | null | undefined) {
  if (!email) return undefined
  return getUsers().find((u: any) => u.email === email.toLowerCase())
}

// 스스로 가입한 계정은 뷰어로 시작한다 — 관리자 승격은 운영 정책의 몫이다(S15P11E101-475).
/**
 * @param {Partial<import('../live/contracts').StoredUser> & { email: string, password: string }} form
 * @returns {import('../live/contracts').StoredUser}
 */
export function addUser({ email, password, name, phone, birth, gender, role = ROLE_VIEWER }: Partial<import('../live/contracts').StoredUser> & { email: string, password: string }) {
  const users = getUsers()
  if (users.some((u: any) => u.email === email.toLowerCase())) throw new Error('이미 가입된 이메일입니다.')
  const nu = { email: email.toLowerCase(), password, name, phone, birth, gender, role }
  users.push(nu); writeUsers(users)
  return nu
}

/**
 * @param {string} email
 * @param {Partial<import('../live/contracts').StoredUser>} patch
 * @returns {import('../live/contracts').StoredUser}
 */
export function updateUser(email: string, patch: Partial<import('../live/contracts').StoredUser>) {
  const users = getUsers()
  const i = users.findIndex((u: any) => u.email === email)
  if (i < 0) throw new Error('사용자를 찾을 수 없습니다.')
  users[i] = { ...users[i], ...patch }; writeUsers(users)
  return users[i]
}

/** @returns {import('../live/contracts').StoredSession | null} */
export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
}
/** @param {string} email */
export function setSession(email: string) { localStorage.setItem(SESSION_KEY, JSON.stringify({ email })) }
export function clearSession() {
  localStorage.removeItem(SESSION_KEY); clearToken(); clearActivity()
}

// ---- 실서버 세션 (JWT) ----
// STOMP CONNECT 헤더와 REST 조회 헤더에 함께 쓰인다.
// 저장된 user는 서버 응답(role)과 로그인 폼 값(email·name)을 합친 공개 정보다.
// expiresAt 은 로그인 응답의 expiresIn 으로 계산한 절대 만료 시각이다(S15P11E101-508).
/** @returns {import('../live/contracts').StoredAuth | null} */
export function getAuth() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null') } catch { return null }
}
/** @param {import('../live/contracts').StoredAuth} auth */
export function setAuth({ accessToken, user, expiresAt = null }: import('../live/contracts').StoredAuth) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, user, expiresAt }))
}
export function clearToken() { localStorage.removeItem(TOKEN_KEY) }
