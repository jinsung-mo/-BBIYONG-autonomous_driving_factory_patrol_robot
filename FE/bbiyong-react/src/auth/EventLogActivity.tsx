import { useEffect, useRef } from 'react'
import { useAuth } from './AuthContext.tsx'
import { useLive } from '../live/LiveContext.tsx'
import { useSim } from '../SimContext.ts'

// 이벤트 로그가 실시간으로 기록되는 동안 세션을 유지한다 (S15P11E101-508).
//
// 관제는 사람이 손대지 않아도 감시 임무를 수행 중일 수 있다. 순찰·과열·화재 이벤트가
// 새로 기록되는 것은 "지켜볼 일이 벌어지고 있다"는 신호이므로 활동으로 본다.
//
// 반대로 텔레메트리·영상·맵 갱신은 여기서 보지 않는다. 로봇 전원이 켜져 있기만 하면
// 끊임없이 흐르므로, 활동으로 치면 유휴 판정이 영원히 성립하지 않는다.
export default function EventLogActivity(): null {
  const { touch, locked } = useAuth()
  const { enabled, alerts } = useLive()
  const { status, actions } = useSim()

  // 길이가 '늘어났을 때'만 활동으로 본다. 최초 마운트와 필터·초기화로 줄어드는 경우는 제외한다.
  const seenAlerts = useRef(alerts.length)
  const seenLogs = useRef(status.logs.length)

  useEffect(() => {
    if (!enabled) return
    if (alerts.length > seenAlerts.current) touch()
    seenAlerts.current = alerts.length
  }, [enabled, alerts.length, touch])

  useEffect(() => {
    if (enabled) return
    if (status.logs.length > seenLogs.current) touch()
    seenLogs.current = status.logs.length
  }, [enabled, status.logs.length, touch])

  // 조작 잠금·해제를 기록에 남긴다(S15P11E101-653). 최초 마운트에는 남기지 않는다 —
  // 새로고침할 때마다 같은 줄이 쌓이면 기록이 아니라 잡음이다.
  //
  // 실서버 모드의 이벤트 로그는 서버가 주는 목록이라 여기에 끼워 넣지 않는다. 브라우저에만
  // 남는 줄은 감사 기록이 아니다 — 새로고침하면 사라지고 다른 자리에서 확인할 수도 없다.
  // 제대로 남기려면 서버 쪽 감사 API 가 필요하다.
  const seenLock = useRef<boolean | null>(null)
  useEffect(() => {
    if (enabled) return
    if (seenLock.current === null) { seenLock.current = locked; return }
    if (seenLock.current === locked) return
    seenLock.current = locked
    actions.pushLog(locked ? 'heat' : 'ok', locked ? '조작 잠금 — 유휴' : '조작 잠금 해제')
  }, [enabled, locked, actions])

  return null
}
