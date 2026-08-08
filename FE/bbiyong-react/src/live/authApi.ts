// 실서버 인증 REST — docs/fe_backend_integration_guide.md §2.
//
// 여기서 받은 accessToken은 REST 조회 헤더와 STOMP CONNECT 헤더 양쪽에 같이 쓴다(§1).

import { REST_BASE } from './config.ts'

// 인증이 깨졌을 때 알릴 곳. AuthProvider 가 등록해 세션을 정리한다(S15P11E101-508).
// 조회 함수마다 로그아웃을 부르면 순환 참조가 생겨서 이 한 지점으로 모은다.
/** @type {(() => void) | null} */
let onUnauthorized: (() => void) | null = null
/** @param {(() => void) | null} fn */
export function setUnauthorizedHandler(fn: any) { onUnauthorized = fn }

// 401 과 403 은 다른 사건이다(S15P11E101-613).
//   401 — 토큰이 죽었다. refresh 로 살릴 수 있고, 못 살리면 로그아웃이다.
//   403 — 토큰은 멀쩡한데 그 일을 할 권한이 없다. 로그아웃시키면 안 된다.
// 예전에는 둘 다 로그아웃이었다. 608 에서 ROLE_USER 가 생기면 관리자 전용 API 의 403 이
// 정상 흐름이 되므로, 그때 로그아웃되면 화면을 쓸 수 없다.
/** @param {number} status */
function checkAuthFailure(status: number) {
  if (status === 401) onUnauthorized?.()
}

// ---- refresh 연동 (S15P11E101-613) ----
//
// AuthProvider 가 다리를 놓는다. authApi 는 리액트 상태를 모르고, AuthProvider 는
// 매 호출부를 모르기 때문에 이 한 지점으로 주고받는다.
type AuthBridge = {
  /** 지금 들고 있는 refreshToken. 없으면 갱신을 시도하지 않는다(구버전 서버). */
  getRefreshToken: () => string | null | undefined
  /** 갱신 성공 — 저장소·상태·STOMP 토큰을 함께 맞춘다 */
  onRefreshed: (res: import('./contracts').RefreshResponse) => void
}
let bridge: AuthBridge | null = null
export function setAuthBridge(b: AuthBridge | null) { bridge = b }

/**
 * refresh 토큰으로 access 를 재발급한다.
 * @param {string} refreshToken
 * @returns {Promise<import('./contracts').RefreshResponse>}
 */
export function refreshRequest(refreshToken: string) {
  return post('/api/auth/refresh', { refreshToken })
}

// 동시에 여러 요청이 401 을 받으면 갱신도 여러 번 나간다. 서버가 refresh 를 회전시키면
// 뒤의 것이 죽은 토큰을 쓰게 되므로, 진행 중인 갱신 하나를 모두가 기다린다.
let inflight: Promise<string | null> | null = null

/**
 * 갱신을 한 번만 돌리고 새 accessToken 을 돌려준다. 갱신할 수 없거나 실패하면 null.
 * @returns {Promise<string | null>}
 */
export function refreshAccessToken(): Promise<string | null> {
  if (inflight) return inflight
  const rt = bridge?.getRefreshToken()
  if (!rt) return Promise.resolve(null)
  inflight = refreshRequest(rt)
    .then((res: any) => {
      if (!res?.accessToken) return null
      bridge?.onRefreshed(res)
      return res.accessToken as string
    })
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
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

// 요청 한 번. 네트워크 실패는 같은 문구로 던지고, 그 밖에는 응답과 본문을 그대로 돌려준다
// (401 재시도를 위해 호출부가 status 를 봐야 한다).
async function sendRequest(url: string, init: RequestInit) {
  let res
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE)
  }
  const data = await res.json().catch((): any => null)
  return { res, data }
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

// ---- 이메일 인증 · 아이디/비밀번호 찾기 (S15P11E101) ----
//
// 인증 상태는 서버가 이메일 기준으로 들고 있다(토큰 불필요). send → verify 를 거친 뒤에야
// signup 이 통과하므로, 화면은 verify 성공만 확인하고 그대로 가입을 진행하면 된다.

/** 회원가입 이메일로 인증코드를 발송한다. 이미 가입된 이메일이면 409. */
export function sendSignupCode(email: string) {
  return post('/api/auth/email/send-code', { email })
}

/** 회원가입 이메일 인증코드를 검증한다. 성공 시 서버가 해당 이메일을 '인증됨'으로 표시한다. */
export function verifySignupCode(email: string, code: string) {
  return post('/api/auth/email/verify-code', { email, code })
}

/** 아이디(이메일) 찾기 — 이름·휴대전화(숫자만)·생년월일 일치 시 마스킹된 이메일을 반환한다. */
export function findIdRequest(name: string, phoneNumber: string, birthDate: string) {
  return post('/api/auth/find-id', { name, phoneNumber, birthDate })
}

/** 비밀번호 재설정 인증코드 발송. 계정 열거 방지를 위해 미가입 이메일도 동일하게 200. */
export function sendResetCode(email: string) {
  return post('/api/auth/password/send-reset-code', { email })
}

/** 비밀번호 재설정 — 인증코드 + 새 비밀번호(정책 검증은 서버가 한다). */
export function resetPasswordRequest(email: string, code: string, newPassword: string) {
  return post('/api/auth/password/reset', { email, code, newPassword })
}

/**
 * 인가가 필요한 조회 API 공통 호출부.
 * 반환 타입은 호출부가 제네릭 대신 JSDoc 캐스트로 좁힌다(JS 라 제네릭 호출을 못 쓴다).
 * @param {string} path
 * @param {string | null | undefined} accessToken
 * @returns {Promise<any>}
 */
export async function authedGet(path: string, accessToken: string | null | undefined) {
  // 401 이면 한 번만 갱신하고 같은 요청을 다시 보낸다(S15P11E101-613).
  // 호출부는 이 사실을 몰라도 된다 — 시그니처가 그대로라 기존 코드가 바뀌지 않는다.
  const run = (token: string | null | undefined) => sendRequest(`${REST_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  let { res, data } = await run(accessToken)
  if (res.status === 401) {
    const next = await refreshAccessToken()
    if (next) ({ res, data } = await run(next))
  }
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
  // 본문은 한 번만 직렬화해 둔다 — 재시도 때 같은 내용을 그대로 보낸다
  const payload = body ? JSON.stringify(body) : undefined
  const run = (token: string | null | undefined) => sendRequest(`${REST_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: payload } : {}),
  })

  let { res, data } = await run(accessToken)
  if (res.status === 401) {
    const next = await refreshAccessToken()
    if (next) ({ res, data } = await run(next))
  }
  if (!res.ok) {
    checkAuthFailure(res.status)
    throw responseError(data, res.status)
  }
  return data
}
