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

// phone·birth·gender 는 S15P11E101-493 에서 추가된 필수 입력이다.
// 서버 스키마(명세 1.1)에는 아직 없어 지금은 무시되지만, BE 반영 시 FE 수정 없이 바로 저장되도록
// 처음부터 실어 보낸다. 값이 없으면 필드를 빼서 보낸다(빈 문자열로 덮어쓰지 않는다).
// phone 은 하이픈 없는 숫자만 온다(AuthContext 에서 정규화 — BE 협의).
export function signupRequest({ email, password, name, phone, birth, gender }) {
  return post('/api/auth/signup', {
    email, password, name,
    ...(phone ? { phone } : {}),
    ...(birth ? { birth } : {}),
    ...(gender ? { gender } : {}),
  })
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

// 인가가 필요한 변경 API 공통 호출부(POST/PATCH/PUT).
// 호출부가 상태 코드로 분기할 수 있게 error.status 를 실어 던진다 —
// 예를 들어 404/405 는 "요청 실패" 가 아니라 "서버에 아직 그 API 가 없다" 이다.
export async function authedSend(path, accessToken, { method = 'POST', body } = {}) {
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
    const err = new Error(data?.message || `요청 실패 (HTTP ${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}
