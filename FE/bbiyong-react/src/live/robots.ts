// 로봇 조치 API — 조회가 아니라 로봇에 무언가를 시키는 쪽이다.
//
// BE 계약: RobotController (/api/robots).
//   POST /api/robots/{robotId}/recover/nav2  → RobotRecoveryResponse
//
// 🔴 이 호출은 로봇의 Nav2(경로 계산·주행 제어)를 통째로 내렸다 올린다. 도는 동안
//    로봇이 움직일 수 없고, 순찰 중이었다면 순찰이 끊긴다. 그래서 반드시 사용자 확인을
//    한 번 받은 뒤에만 부른다(EventDetailModal 의 확인 모달).
//
//    자동 재시도·자동 호출을 붙이지 마라. 로봇 쪽 게이트에서 자동복구를 일부러 껐고
//    (사용자 지침 2026-08-10), 이 버튼이 유일한 복구 경로다.

import { authedSend } from './authApi.ts'
import { ROBOT_ID } from './config.ts'

/**
 * 응답은 **하달까지의 결과일 뿐 복구의 성패가 아니다.** 재기동은 수십 초가 걸려 HTTP
 * 응답 안에서 기다릴 수 없다. 성패는 로봇이 되돌려 주는 이벤트 로그
 * (PLANNER_RECOVER_OK / PLANNER_RECOVER_FAILED)로 확인한다.
 *
 * - `ACCEPTED`    로봇에 하달됨
 * - `IN_PROGRESS` 이미 복구 중 (서버가 로봇별 180초 쿨다운을 건다)
 * - `OFFLINE`     로봇 미연결
 * - `INVALID`     robotId 누락
 */
export function recoverNav2(
  accessToken: string | null | undefined,
  robotId: string = ROBOT_ID,
): Promise<import('./contracts.d.ts').RobotRecoveryResult> {
  return authedSend(
    `/api/robots/${encodeURIComponent(robotId)}/recover/nav2`,
    accessToken,
    { method: 'POST' },
  )
}

/** 하달 결과 → 화면에 그대로 보여 줄 문장. 서버 message 가 있으면 그것을 우선한다. */
export function recoverMessage(
  r: import('./contracts.d.ts').RobotRecoveryResult | null | undefined,
): { kind: string, text: string } {
  const text = r?.message || '복구 요청을 보냈습니다.'
  if (r?.result === 'ACCEPTED') return { kind: 'ok', text }
  if (r?.result === 'IN_PROGRESS') return { kind: 'warn', text }
  return { kind: 'err', text }
}
