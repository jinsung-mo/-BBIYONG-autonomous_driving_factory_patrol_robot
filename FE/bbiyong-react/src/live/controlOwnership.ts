// 조종 점유(control ownership) — BE MR !344 / S15P11E101-778 · 779 계약.
//
// 서버가 로봇 1대에 대해 "지금 누가 조종 중인가"를 리스(lease)로 들고 있고,
// 비소유자의 제어 명령은 로봇에 중계하지 않고 드롭한다. 관제 화면은 그 사실을
// 사람에게 보여 주고, 남이 잡고 있는 동안에는 수동 모드 진입 자체를 막아야 한다.
//
//   SUBSCRIBE /topic/control/{robotId}
//     { robotId, event, owner, ownerEmail, leftMs, serverTime }
//     event = ACQUIRED | RELEASED | TAKEN_OVER | EXPIRED | DISCONNECTED | HEARTBEAT | STATUS
//     점유가 없으면 owner·ownerEmail 은 null, leftMs 는 0.
//   SUBSCRIBE /user/queue/control
//     { type:'CONTROL_DENIED', robotId, reason, owner, ownerEmail, leftMs, serverTime }
//     reason = FORBIDDEN_ROLE | OWNED_BY_OTHER | TAKEN_OVER_BY_OTHER
//   SEND      /app/control/ownership
//     { robot_id, command: ACQUIRE | TAKEOVER | RELEASE | STATUS }
//
// owner 는 STOMP sessionId 다. 같은 계정으로 두 탭을 열면 email 은 같으므로,
// "내가 조종 중인가"는 email 이 아니라 sessionId 로 갈라야 한다.

/** 서버 리스 유효시간(ControlOwnershipService.LEASE_MILLIS). */
export const LEASE_MS = 2000

/**
 * 점유 중일 때 서버 스윕이 HEARTBEAT 를 보내는 주기(500ms).
 * 이 값의 배수로 무수신 판정을 잡는다.
 */
export const HEARTBEAT_MS = 500

/**
 * 이 시간 넘게 갱신이 없으면 화면의 점유 표시를 "확인 중"으로 내린다.
 *
 * 리스 2초 + 하트비트 500ms 를 감안한 여유값이다. STOMP 는 push 라 폴링처럼
 * 백그라운드 탭에서 멈추지는 않지만, 소켓이 조용히 끊기거나 재연결 중일 때
 * 마지막으로 받은 값을 현재 사실인 양 단언하면 안 된다 — 3초 넘게 소식이 없으면
 * "모른다"로 내려가고 STATUS 를 다시 물어본다.
 */
export const OWNERSHIP_STALE_MS = 3000

/**
 * 점유 유지용 재획득 주기. 리스 2초의 약 1/3 이라 한두 번 유실돼도 끊기지 않는다.
 * 이미 내 것이면 서버는 RENEWED 로 처리하고 브로드캐스트조차 하지 않으므로 값이 싸다.
 */
export const OWNERSHIP_KEEPALIVE_MS = 700

export const OWNERSHIP_DEST = '/app/control/ownership'
export const OWNERSHIP_QUEUE = '/user/queue/control'
export const ownershipTopic = (robotId: string) => `/topic/control/${robotId}`

export const DENY = {
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  OWNED_BY_OTHER: 'OWNED_BY_OTHER',
  TAKEN_OVER_BY_OTHER: 'TAKEN_OVER_BY_OTHER',
} as const

export type OwnershipEvent =
  'ACQUIRED' | 'RELEASED' | 'TAKEN_OVER' | 'EXPIRED' | 'DISCONNECTED' | 'HEARTBEAT' | 'STATUS'

/** 내 점유 요청이 어디까지 갔는지. owner(sessionId) 를 못 알아내도 이 값으로 판단한다. */
export type OwnershipClaim = 'none' | 'pending' | 'owner' | 'denied'

export interface OwnershipSnapshot {
  /** /topic/control 을 한 번이라도 받았다 = 서버가 이 기능을 갖고 있다 */
  supported: boolean
  /** 현재 소유자 STOMP sessionId. 점유 없으면 null */
  owner: string | null
  ownerEmail: string | null
  event: OwnershipEvent | null
  /** 서버가 알려 준 잔여 리스(ms) — 수신 시각 기준 */
  leftMs: number
  /** 이 브라우저가 그 메시지를 받은 로컬 시각 */
  receivedAt: number
  claim: OwnershipClaim
  denied: { reason: string, ownerEmail: string | null, at: number } | null
}

export const EMPTY_OWNERSHIP: OwnershipSnapshot = {
  supported: false, owner: null, ownerEmail: null, event: null,
  leftMs: 0, receivedAt: 0, claim: 'none', denied: null,
}

/**
 * 페이로드는 JSON 문자열로 온다(/topic/robots 와 같다). stompClient.parse 가 이미
 * 한 번 JSON.parse 하지만, 서버가 문자열을 Jackson 으로 한 번 더 감싸는 구성일 수도 있어
 * 문자열이 남아 있으면 한 번 더 푼다 — 어느 쪽이든 객체를 얻는다.
 */
export function parseControlPayload(msg: any): any {
  let out = msg
  if (typeof out === 'string') {
    try { out = JSON.parse(out) } catch { return null }
  }
  return (out && typeof out === 'object') ? out : null
}

/**
 * 마지막 수신 이후 흐른 시간을 빼서 지금 기준 잔여 리스를 계산한다.
 * 서버 시계를 그대로 믿지 않고 로컬 경과분만 차감한다 — 시계 오차를 끌어들이지 않는다.
 */
export function leftMsNow(snap: OwnershipSnapshot, now: number): number {
  if (!snap.owner || !snap.receivedAt) return 0
  return Math.max(0, snap.leftMs - (now - snap.receivedAt))
}

/** 갱신이 끊긴 상태. 점유가 있다고 알고 있을 때만 의미가 있다(비어 있으면 서버가 아무것도 안 보낸다). */
export function isStale(snap: OwnershipSnapshot, now: number): boolean {
  if (!snap.supported || !snap.owner || !snap.receivedAt) return false
  return now - snap.receivedAt > OWNERSHIP_STALE_MS
}

/** 내가 소유자인가. sessionId 를 알아냈으면 그것으로, 못 알아냈으면 claim 으로 판단한다. */
export function isMine(snap: OwnershipSnapshot, mySessionId: string | null): boolean {
  if (!snap.owner) return false
  if (mySessionId) return snap.owner === mySessionId
  return snap.claim === 'owner'
}

/** 남이 잡고 있는가 — 수동 모드 진입을 막는 조건이다. */
export function isOwnedByOther(snap: OwnershipSnapshot, mySessionId: string | null): boolean {
  return !!snap.owner && !isMine(snap, mySessionId)
}

/** 배너 문구용 — 0.1초 단위 */
export function formatLeft(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1)
}
