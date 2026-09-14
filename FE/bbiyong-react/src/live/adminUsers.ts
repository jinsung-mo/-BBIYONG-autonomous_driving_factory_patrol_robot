// 사용자 관리 (관리자 전용) — /api/admin/users (S15P11E101-614)
//
// BE 계약: AdminUserController. 컨트롤러에 @PreAuthorize("hasRole('ADMIN')") 가 걸려 있어
// 관리자가 아니면 403 이 온다 — FE 가 버튼을 감추는 것과 별개로 서버가 최종 판단한다.
//
//   GET   /api/admin/users        → UserSummaryResponse[] { id, email, name, role }
//   PATCH /api/admin/users/role   { email, role }  → 바뀐 UserSummaryResponse
//
// role 은 서버 enum(ROLE_ADMIN | ROLE_USER) 그대로 보낸다. 표시 문구를 보내면 400 이다.

import { authedGet, authedSend } from './authApi.ts'

type AdminUser = import('./contracts').AdminUser

/** @returns {Promise<import('./contracts').AdminUser[]>} */
export async function listUsers(accessToken: string | null | undefined) {
  const rows = await authedGet('/api/admin/users', accessToken)
  return (Array.isArray(rows) ? rows : (rows?.content || [])) as AdminUser[]
}

/**
 * 승격·강등. 서버가 바뀐 사용자 한 건을 돌려주므로 목록을 다시 받지 않고 그 행만 고칠 수 있다.
 * @param {string} email
 * @param {string} role ROLE_ADMIN | ROLE_USER
 * @returns {Promise<import('./contracts').AdminUser>}
 */
export function changeUserRole(
  email: string,
  role: string,
  accessToken: string | null | undefined,
) {
  return authedSend('/api/admin/users/role', accessToken, {
    method: 'PATCH',
    body: { email, role },
  })
}

// 관리자가 자기 자신을 강등하면 그 순간 운영·설정 탭과 이 화면까지 잃는다.
// 되돌리려면 다른 관리자가 필요하므로, 누르기 전에 한 번 붙잡는다.
export const isSelfDemotion = (target: string, me: string | null | undefined, nextRole: string) =>
  !!me && target.toLowerCase() === me.toLowerCase() && nextRole !== 'ROLE_ADMIN'

// 관리자가 한 명뿐인데 그 한 명을 강등하면 승격시켜 줄 사람이 남지 않는다.
export const isLastAdmin = (rows: AdminUser[], target: string) => {
  const admins = rows.filter((u) => u.role === 'ROLE_ADMIN')
  return admins.length === 1 && admins[0].email.toLowerCase() === target.toLowerCase()
}
