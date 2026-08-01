// 권한 (S15P11E101-475)
//
// 백엔드가 로그인 응답으로 role 을 내려준다(ROLE_ADMIN 등). 관제는 두 등급만 구분한다.
//   관리자(ROLE_ADMIN) — 조작 · 운영 · 설정 전부
//   뷰어(그 외)        — 모니터링만. 조작 버튼은 숨기지 않고 비활성으로 보여준다.
//
// 숨기지 않는 이유: 버튼이 아예 없으면 "기능이 없는 화면"으로 오해하지만,
// 회색으로 남아 있으면 "권한이 없어서 못 누른다"는 것이 드러난다.

export const ROLE_ADMIN = 'ROLE_ADMIN'
export const ROLE_VIEWER = 'ROLE_VIEWER'

// 예전 mock 계정은 role 에 표시 문구('관제 권한')를 그대로 담아 두었다.
// 그 시절 계정은 전부 전권이었으므로 관리자로 본다(로컬 저장소 하위호환).
const LEGACY_ADMIN = '관제 권한'

/** @param {string | null | undefined} role */
export const isAdminRole = (role) => role === ROLE_ADMIN || role === LEGACY_ADMIN

/** @param {string | null | undefined} role */
export const roleText = (role) => (isAdminRole(role) ? '관리자' : '뷰어')
