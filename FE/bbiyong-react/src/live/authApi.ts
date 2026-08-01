// 실서버 인증 REST — docs/fe_backend_integration_guide.md §2.
//
// 여기서 받은 accessToken은 REST 조회 헤더와 STOMP CONNECT 헤더 양쪽에 같이 쓴다(§1).

import { REST_BASE } from './config.ts'

// 인증이 깨졌을 때(401/403) 알릴 곳. AuthProvider 가 등록해 세션을 정리한다(S15P11E101-508).
// 조회 함수마다 로그아웃을 부르면 순환 참조가 생겨서 이 한 지점으로 모은다.
/** @type {(() => void) | null} */
let onUnauthorized = null
/** @param {(() => void) | null} fn */
export function setUnauthorizedHandler(fn: any) { onUnauthorized = fn }

/** @param {number} status */
function checkAuthFailure(status: number) {
  if (status === 401 || status === 403) onUnauthorized?.()
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @returns {Promise<any>} 응답 스키마는 호출부가 좁힌다
 */
async function post(path: string, body: Record<string, unknown>) {
  let res
  try {
    res = await fetch(`${REST_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('실서버에 연결할 수 없습니다. 네트워크를 확인하세요.')
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    // 공통 에러 응답 포맷의 message를 우선 노출 (§1.0)
    throw new Error(data?.message || `요청 실패 (HTTP ${res.status})`)
  }
  return data
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('./contracts').LoginResponse>}
 */
export function loginRequest(email: string, password: string) {
  return post('/api/auth/login', { email, password })
}

// phone·birth·gender 는 S15P11E101-493 에서 추가된 필수 입력이다.
// 서버 스키마(명세 1.1)에는 아직 없어 지금은 무시되지만, BE 반영 시 FE 수정 없이 바로 저장되도록
// 처음부터 실어 보낸다. 값이 없으면 필드를 빼서 보낸다(빈 문자열로 덮어쓰지 않는다).
// phone 은 하이픈 없는 숫자만 온다(AuthContext 에서 정규화 — BE 협의).
/**
 * @param {{ email: string, password: string, name?: string,
 *           phone?: string, birth?: string, gender?: string }} form
 * @returns {Promise<any>}
 */
export function signupRequest({ email, password, name, phone, birth, gender }: { email: string, password: string, name?: string,
            phone?: string, birth?: string, gender?: string }) {
  return post('/api/auth/signup', {
    email, password, name,
    ...(phone ? { phone } : {}),
    ...(birth ? { birth } : {}),
    ...(gender ? { gender } : {}),
  })
}

/**
 * 인가가 필요한 조회 API 공통 호출부.
 * 반환 타입은 호출부가 제네릭 대신 JSDoc 캐스트로 좁힌다(JS 라 제네릭 호출을 못 쓴다).
 * @param {string} path
 * @param {string | null | undefined} accessToken
 * @returns {Promise<any>}
 */
export async function authedGet(path: string, accessToken: string | null | undefined) {
  const res = await fetch(`${REST_BASE}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    checkAuthFailure(res.status)
    throw new Error(data?.message || `요청 실패 (HTTP ${res.status})`)
  }
  return data
}

// 인가가 필요한 변경 API 공통 호출부(POST/PATCH/PUT).
// 호출부가 상태 코드로 분기할 수 있게 error.status 를 실어 던진다 —
// 예를 들어 404/405 는 "요청 실패" 가 아니라 "서버에 아직 그 API 가 없다" 이다.
/**
 * @param {string} path
 * @param {string | null | undefined} accessToken
 * @param {{ method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown }} [opts]
 * @returns {Promise<any>}
 */
export async function authedSend(
  path: string,
  accessToken: string | null | undefined,
  { method = 'POST', body }: { method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown } = {},
) {
  let res
  try {
    res = await fetch(`${REST_BASE}${path}`, {
      method,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new Error('실서버에 연결할 수 없습니다. 네트워크를 확인하세요.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    checkAuthFailure(res.status)
    const err: import('./contracts').HttpError =
      new Error(data?.message || `요청 실패 (HTTP ${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}
