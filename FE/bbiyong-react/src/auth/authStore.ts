// 목(mock) 회원 저장소 — localStorage 기반. 백엔드 없이 인증 흐름을 재현한다.
// 실제 배포 시 Spring 메인서버(FN-M01/M02) 인증으로 교체하는 것을 전제로 한 자리표시자.
import type { Session, StoredUser } from '../types'

const USERS_KEY = 'bbiyong.users'
const SESSION_KEY = 'bbiyong.session'

// 데모용 기본 관리자 계정
const SEED: StoredUser[] = [{ email: 'safety@bbiyong.io', password: 'bbiyong', name: 'E101 관리자', role: '관제 권한' }]

function readUsers(): StoredUser[] | null {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) as string) } catch { return null }
}
function writeUsers(users: StoredUser[]) { localStorage.setItem(USERS_KEY, JSON.stringify(users)) }

export function getUsers(): StoredUser[] {
  let users = readUsers()
  if (!Array.isArray(users) || users.length === 0) { users = SEED.slice(); writeUsers(users) }
  return users
}

export function findUser(email?: string): StoredUser | undefined {
  if (!email) return undefined
  return getUsers().find((u) => u.email === email.toLowerCase())
}

export function addUser({ email, password, name, role = '관제 권한' }: { email: string; password: string; name: string; role?: string }): StoredUser {
  const users = getUsers()
  if (users.some((u) => u.email === email.toLowerCase())) throw new Error('이미 가입된 이메일입니다.')
  const nu: StoredUser = { email: email.toLowerCase(), password, name, role }
  users.push(nu); writeUsers(users)
  return nu
}

export function updateUser(email: string, patch: Partial<StoredUser>): StoredUser {
  const users = getUsers()
  const i = users.findIndex((u) => u.email === email)
  if (i < 0) throw new Error('사용자를 찾을 수 없습니다.')
  users[i] = { ...users[i], ...patch }; writeUsers(users)
  return users[i]
}

export function getSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) as string) } catch { return null }
}
export function setSession(email: string) { localStorage.setItem(SESSION_KEY, JSON.stringify({ email })) }
export function clearSession() { localStorage.removeItem(SESSION_KEY) }
