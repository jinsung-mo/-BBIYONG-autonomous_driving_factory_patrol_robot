// 실서버 인증 REST — docs/fe_backend_integration_guide.md §2.
//
// 여기서 받은 accessToken은 REST 조회 헤더와 STOMP CONNECT 헤더 양쪽에 같이 쓴다(§1).

import { REST_BASE } from './config.ts'

// 인증이 깨졌을 때(401/403) 알릴 곳. AuthProvider 가 등록해 세션을 정리한다(S15P11E101-508).
// 조회 함수마다 로그아웃을 부르면 순환 참조가 생겨서 이 한 지점으로 모은다.
/** @type {(() => void) | null} */
let onUnauthorized: (() => void) | null = null
/** @param {(() => void) | null} fn */
export function setUnauthorizedHandler(fn: any) { onUnauthorized = fn }

/** @param {number} status */
function checkAuthFailure(status: number) {
  if (status === 401 || status === 403) onUnauthorized?.()
}

const NETWORK_ERROR_MESSAGE = '실서버에 연결할 수 없습니다. 네트워크를 확인하세요.'

// Spring ProblemDetail 은 detail 에 사람이 읽을 메시지를 담는다. 이전 ErrorResponse(message)도
// 함께 받아야 서버 버전이 다른 환경에서도 같은 호출부를 쓸 수 있다.
function responseMessage(data: unknown, status: number) {
  if (data && typeof data === 'object') {
    const body = data as { detail?: unknown, message?: unknown }
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail
    if (typeof body.message === 'string' && body.message.trim()) return body.message
  }
  return `요청 실패 (HTTP ${status})`
}

function responseError(data: unknown, status: number) {
  const err = new Error(responseMessage(data, status)) as Error & { status?: number }
  err.status = status
  return err
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
    throw new Error(NETWORK_ERROR_MESSAGE)
  }

  const data = await res.json().catch((): any => null)
  if (!res.ok) {
    throw responseError(data, res.status)
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

// phone·birth·gender 는 가입 화면의 내부 필드명이다. System API DTO는 각각
// phoneNumber·birthDate·gender 를 받으므로, 이 경계에서 한 번만 계약명으로 변환한다.
// 값이 없으면 필드를 빼서 빈 문자열로 기존 값을 덮어쓰지 않는다.
// phone 은 하이픈 없는 숫자만 온다(AuthContext 에서 정규화).
/**
 * @param {{ email: string, password: string, name?: string,
 *           phone?: string, birth?: string, gender?: string }} form
 * @returns {Promise<any>}
 */
export function signupRequest({ email, password, name, phone, birth, gender }: { email: string, password: string, name?: string,
            phone?: string, birth?: string, gender?: string }) {
  return post('/api/auth/signup', {
    email, password, name,
    ...(phone ? { phoneNumber: phone } : {}),
    ...(birth ? { birthDate: birth } : {}),
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
  let res
  try {
    res = await fetch(`${REST_BASE}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    })
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE)
  }
  const data = await res.json().catch((): any => null)
  if (!res.ok) {
    checkAuthFailure(res.status)
    throw responseError(data, res.status)
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
    throw new Error(NETWORK_ERROR_MESSAGE)
  }
  const data = await res.json().catch((): any => null)
  if (!res.ok) {
    checkAuthFailure(res.status)
    throw responseError(data, res.status)
  }
  return data
}
