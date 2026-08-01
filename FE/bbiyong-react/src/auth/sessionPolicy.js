// @ts-check
// 세션 만료 정책 — S15P11E101-508.
//
// 관제 화면은 일반 업무 화면과 다르다. 순찰·과열·화재 이벤트가 실시간으로 기록되는 동안은
// 시스템이 감시 임무를 수행 중이므로, 사람이 손대지 않아도 세션을 끊으면 안 된다.
// 로그아웃되면 긴급 정지 버튼조차 누를 수 없다.
//
// 그래서 활동 신호를 둘로 본다.
//   (1) 사용자 조작        — 마우스·키보드·터치·스크롤
//   (2) 이벤트 로그 신규 기록 — /topic/alerts 수신, 시뮬 로그 추가
//
// 텔레메트리(배터리·위치·속도 250ms)·영상 프레임·맵 갱신은 활동이 아니다.
// 로봇 전원이 켜져 있기만 하면 끊임없이 흐르므로, 활동으로 치면 유휴 판정이 성립하지 않는다.

// `|| {}` 는 방어용이라 그대로 둔다. 타입만 넓혀 준다(런타임 변화 없음 — S15P11E101-570).
const env = /** @type {Record<string, string | undefined>} */ (import.meta.env || {})
const minutes = (v, fallback) => {
  const n = Number(v)
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60 * 1000
}

// 운영 중 조정될 값이라 상수 한 곳에 모으고 env 로도 덮을 수 있게 둔다.
export const IDLE_MS = minutes(env.VITE_SESSION_IDLE_MIN, 60)
export const WARN_MS = minutes(env.VITE_SESSION_WARN_MIN, 2)

export const ACTIVITY_KEY = 'bbiyong.activity'

/**
 * 자동 로그아웃 사유. as const 로 리터럴을 고정해 오타·미정의 값을 빌드에서 막는다.
 * @type {{ IDLE: 'idle', EXPIRED: 'expired', MANUAL: 'manual' }}
 */
export const REASON = {
  IDLE: 'idle',        // 장시간 활동 없음
  EXPIRED: 'expired',  // 토큰 수명 만료
  MANUAL: 'manual',    // 사용자가 직접 로그아웃
}

export const REASON_TEXT = {
  [REASON.IDLE]: '장시간 활동이 없어 자동으로 로그아웃되었습니다. 다시 로그인해 주세요.',
  [REASON.EXPIRED]: '세션이 만료되어 로그아웃되었습니다. 다시 로그인해 주세요.',
}

/** @returns {number} 마지막 활동 시각(ms). 기록이 없으면 0 */
export function readActivity() {
  const raw = Number(localStorage.getItem(ACTIVITY_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** @param {number} [at] @returns {number} */
export function writeActivity(at = Date.now()) {
  localStorage.setItem(ACTIVITY_KEY, String(at))
  return at
}

export function clearActivity() { localStorage.removeItem(ACTIVITY_KEY) }

// 남은 시간(ms). 활동 기록이 없으면 방금 활동한 것으로 본다 — 기록 이전의 세션을
// 곧바로 만료시키면 배포 직후 로그인해 있던 사용자가 이유 없이 튕긴다.
/**
 * @param {number} [now]
 * @param {number} [last]
 * @returns {number} 남은 ms. 0 이하면 만료
 */
export function idleRemaining(now = Date.now(), last = readActivity()) {
  if (!last) return IDLE_MS
  return last + IDLE_MS - now
}

// 절대 만료까지 남은 시간(ms). expiresAt 이 없으면(mock 모드) 만료하지 않는다.
/**
 * @param {number | null | undefined} expiresAt
 * @param {number} [now]
 * @returns {number} 남은 ms. expiresAt 이 없으면 Infinity
 */
export function absoluteRemaining(expiresAt, now = Date.now()) {
  return expiresAt ? expiresAt - now : Infinity
}
