// @ts-check
// 주행 속도 상한 API — S15P11E101-515.
// BE 계약: SettingsController / DriveSettingService (S15P11E101-512).
//
//   GET /api/settings/drive-speed?robotId=  → { robotId, maxLinear, maxAngular, delivered:null, updatedAt }
//   PUT /api/settings/drive-speed?robotId=  { maxLinear, maxAngular }  (둘 다 양수 필수)
//                                           → 같은 형태 + delivered (로봇 SET_MAX_SPEED 중계 성공 여부)
//
// 서버 기본값은 0.5 / 0.5 이고, 저장된 값이 없으면 그것을 돌려준다.

import { authedGet, authedSend } from './authApi.js'
import { ROBOT_ID } from './config.js'

/** @param {string} [robotId] */
const q = (robotId = ROBOT_ID) => (robotId ? `?robotId=${encodeURIComponent(robotId)}` : '')

/**
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').DriveSpeed>}
 */
export function getDriveSpeed(accessToken, robotId) {
  return authedGet(`/api/settings/drive-speed${q(robotId)}`, accessToken)
}

/**
 * @param {{ maxLinear: number, maxAngular: number }} limits 둘 다 양수여야 한다(서버 @Positive)
 * @param {string | null | undefined} accessToken
 * @param {string} [robotId]
 * @returns {Promise<import('./contracts').DriveSpeed>}
 */
export function putDriveSpeed({ maxLinear, maxAngular }, accessToken, robotId) {
  return authedSend(`/api/settings/drive-speed${q(robotId)}`, accessToken, {
    method: 'PUT',
    body: { maxLinear, maxAngular },
  })
}

// 서버는 양수만 받는다(@Positive). 보내기 전에 걸러 400 을 왕복하지 않는다.
/**
 * @param {number} maxLinear
 * @param {number} maxAngular
 * @returns {string[]} 비어 있으면 문제 없음
 */
export function speedProblems(maxLinear, maxAngular) {
  const bad = []
  if (!Number.isFinite(maxLinear) || maxLinear <= 0) bad.push('선속도 상한은 0보다 큰 수여야 합니다.')
  if (!Number.isFinite(maxAngular) || maxAngular <= 0) bad.push('각속도 상한은 0보다 큰 수여야 합니다.')
  return bad
}
