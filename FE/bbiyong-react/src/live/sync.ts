// 공유 자원 변경 알림 (/topic/sync)
//
// 순찰 경로·스케줄·저장 맵처럼 REST 로 편집하는 자원은, 편집한 사람 화면만 바뀌고
// 다른 접속자는 새로고침 전까지 옛 값을 봤다. 서버가 변경 커밋 직후 이 토픽으로
// { kind:'resource_sync', resource, robotId? } 를 쏘고, 화면은 자기 자원이 언급되면
// 해당 목록만 GET 으로 다시 읽는다 — 내용을 싣지 않으므로 자원마다 계약이 늘지 않는다.
//
// BE 대응: ResourceSyncBroadcaster (resource 값은 REST 경로 이름과 같다).

import { useEffect, useRef } from 'react'
import { subscribe } from './stompClient.ts'

export const SYNC_TOPIC = '/topic/sync'

/**
 * resource 가 바뀌었다는 알림이 오면 onChange 를 부른다.
 *
 * onChange 는 ref 로 들고 있어 매 렌더 새 함수를 넘겨도 재구독하지 않는다 —
 * 재구독 사이 알림이 빠지면 그 화면만 조용히 뒤처진다.
 */
export function useResourceSync(resource: string, onChange: () => void) {
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => subscribe(SYNC_TOPIC, (m: any) => {
    if (m?.kind !== 'resource_sync' || m?.resource !== resource) return
    cb.current()
  }), [resource])
}
