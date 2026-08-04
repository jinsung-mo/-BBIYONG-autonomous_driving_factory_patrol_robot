import { authedSend } from './authApi.ts'

export type DemoAlertType = 'FIRE' | 'OVERHEAT'

// 설정 화면의 시연 버튼도 Swagger와 같은 서버 경보 API를 호출한다.
// 로컬 Simulation 상태를 직접 바꾸지 않아야 STOMP 경보와 중복되지 않는다.
export function triggerDemoAlert(
  type: DemoAlertType,
  robotId: string,
  accessToken: string | null | undefined,
) {
  const query = new URLSearchParams({ robotId })
  return authedSend(`/api/admin/event-simulations/${type}?${query}`, accessToken)
}
