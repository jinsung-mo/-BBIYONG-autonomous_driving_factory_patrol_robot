// 실서버 인증 REST — docs/fe_backend_integration_guide.md §2.
//
// 여기서 받은 accessToken은 REST 조회 헤더와 STOMP CONNECT 헤더 양쪽에 같이 쓴다(§1).

import { REST_BASE } from './config.js'

async function post(path, body) {
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

// → { tokenType, accessToken, expiresIn, role }
export function loginRequest(email, password) {
  return post('/api/auth/login', { email, password })
}

export function signupRequest({ email, password, name }) {
  return post('/api/auth/signup', { email, password, name })
}

// 인가가 필요한 조회 API 공통 호출부
export async function authedGet(path, accessToken) {
  const res = await fetch(`${REST_BASE}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.message || `요청 실패 (HTTP ${res.status})`)
  return data
}
