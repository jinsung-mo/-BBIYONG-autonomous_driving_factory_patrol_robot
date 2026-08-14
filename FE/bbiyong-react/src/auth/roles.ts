// 권한 (S15P11E101-475)
//
// 백엔드가 로그인 응답으로 role 을 내려준다(ROLE_ADMIN 등). 관제는 두 등급만 구분한다.
//   관리자(ROLE_ADMIN) — 조작 · 운영 · 설정 전부
//   뷰어(그 외)        — 모니터링만. 조작 버튼은 숨기지 않고 비활성으로 보여준다.
//
// 숨기지 않는 이유: 버튼이 아예 없으면 "기능이 없는 화면"으로 오해하지만,
// 회색으로 남아 있으면 "권한이 없어서 못 누른다"는 것이 드러난다.

export const ROLE_ADMIN = 'ROLE_ADMIN'
// 실서버가 신규 가입자에게 주는 등급(S15P11E101-608). 조작 없이 모니터링만 한다.
export const ROLE_USER = 'ROLE_USER'
// 시뮬(mock) 저장소가 쓰던 이름. 실서버에는 없고 로컬 계정 하위호환으로만 남는다.
export const ROLE_VIEWER = 'ROLE_VIEWER'

// 예전 mock 계정은 role 에 표시 문구('관제 권한')를 그대로 담아 두었다.
// 그 시절 계정은 전부 전권이었으므로 관리자로 본다(로컬 저장소 하위호환).
const LEGACY_ADMIN = '관제 권한'

/** @param {string | null | undefined} role */
export const isAdminRole = (role: any) => role === ROLE_ADMIN || role === LEGACY_ADMIN

// 관리자가 아닌 등급은 실서버 ROLE_USER 와 시뮬 ROLE_VIEWER 두 갈래다.
// 권한 판정은 같지만(조작 불가) 화면 문구는 서버가 준 이름을 그대로 비춘다 —
// '뷰어'라고 적어 두면 실서버에서 자기 등급을 찾을 수 없다.
const TEXT: Record<string, string> = {
  [ROLE_ADMIN]: '관리자',
  [ROLE_USER]: '사용자',
  [ROLE_VIEWER]: '뷰어',
  [LEGACY_ADMIN]: '관리자',
}

/** @param {string | null | undefined} role */
export const roleText = (role: any) => TEXT[role] || (isAdminRole(role) ? '관리자' : '사용자')

/** 승격·강등 화면에서 고를 수 있는 등급 — 실서버 Role enum 과 같다(S15P11E101-608). */
export const ASSIGNABLE_ROLES: Array<{ value: string, label: string }> = [
  { value: ROLE_ADMIN, label: '관리자' },
  { value: ROLE_USER, label: '사용자' },
]
