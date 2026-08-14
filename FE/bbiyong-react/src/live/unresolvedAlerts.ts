import { useEffect, useRef, useState } from 'react'
import { useLive } from './LiveContext.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { fetchEvents } from './events.ts'

// 3D 지도의 경보 핀 소스(S15P11E101-911).
//
// 예전에는 실시간 경보(useLive().alerts)만 썼다 — 메모리에만 있어 새로고침하면 비고,
// eventId 가 없어 저장 영상도 못 물어봤다. 그래서 핀이 "해결하지 않았는데도" 새로고침에
// 사라지고, 말풍선은 실시간 영상만 보여 줬다.
//
// 이제 서버의 '미해결' 화재/과열 이벤트를 주기적으로 읽는다. 이벤트에는 eventId·좌표·
// 상태가 있으므로: ① 저장된 전후 영상을 열 수 있고 ② 해결(RESOLVED) 처리 전까지 핀이
// 유지되며 ③ 새로고침해도 서버에서 다시 복원된다. 실시간 즉시성은 호출부에서 alerts 와
// 병합해 메운다(방금 발생해 아직 목록에 안 오른 경보).
const POLL_MS = 12_000
const PAGE_SIZE = 100

export function useUnresolvedAlertEvents() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()
  const [events, setEvents] = useState<any[]>([])
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (!enabled || !accessToken) { setEvents([]); return undefined }
    let on = true
    const load = async () => {
      try {
        const res = await fetchEvents({ page: 0, size: PAGE_SIZE, status: 'UNRESOLVED' }, accessToken)
        const rows = (res?.content || []).filter((e: any) => e?.type === 'FIRE' || e?.type === 'OVERHEAT')
        if (on && alive.current) setEvents(rows)
      } catch { /* 조회 실패 시 이전 값 유지 — 잠깐의 네트워크 오류로 핀이 깜빡이지 않게 */ }
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { on = false; clearInterval(id) }
  }, [enabled, accessToken])

  return events
}
