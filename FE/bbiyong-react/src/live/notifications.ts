// Mattermost 알림 설정 — GET/PUT /api/notifications/settings (NotificationController)
//
// 삐용은 20시~08시 무인 시간대에만 돈다. 그 시간에는 관제 화면을 보는 사람이 없으므로
// 화재·과열은 화면 밖으로 나가야 한다. 이 설정이 그 통로다.
//
// 실제 발송은 서버(MattermostNotifier)가 한다 — FE 는 웹훅 URL 을 저장만 하고
// 브라우저에서 직접 웹훅을 때리지 않는다(토큰이 사용자 화면에 노출되면 안 된다).

import { authedGet, authedSend } from './authApi.ts'

/** @returns {Promise<import('./contracts').NotificationSetting>} */
export function fetchNotificationSetting(accessToken: string | null | undefined) {
  return authedGet('/api/notifications/settings', accessToken)
}

/**
 * @param {import('./contracts').NotificationSettingRequest} body
 * @returns {Promise<import('./contracts').NotificationSetting>}
 */
export function saveNotificationSetting(
  body: import('./contracts').NotificationSettingRequest,
  accessToken: string | null | undefined,
) {
  return authedSend('/api/notifications/settings', accessToken, { method: 'PUT', body })
}

export const SEVERITY_HELP: Record<string, string> = {
  CRITICAL: '화재 등 긴급 이벤트만 보냅니다.',
  WARNING: '경고(과열)와 긴급을 모두 보냅니다.',
}

// 서버가 URL 형식을 검증하지만, 눌러 보고 나서 알기보다 입력 중에 알려 주는 편이 낫다.
// 저장 자체를 막지는 않는다 — 사내 Mattermost 주소 형태를 FE 가 단정할 수 없다.
export function webhookProblem(url: string, enabled: boolean) {
  const v = url.trim()
  if (!enabled) return null                       // 꺼 두면 URL 이 비어 있어도 된다
  if (!v) return '알림을 켜려면 웹훅 URL 이 필요합니다.'
  if (!/^https?:\/\//i.test(v)) return 'http:// 또는 https:// 로 시작해야 합니다.'
  return null
}

// 채널명은 앞의 # 을 빼고 보낸다 — Mattermost 는 채널 이름만 받는다.
export const normalizeChannel = (v: string) => v.trim().replace(/^#+/, '')
