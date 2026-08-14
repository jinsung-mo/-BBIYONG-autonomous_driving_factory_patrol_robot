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
const env: Record<string, string | undefined> = import.meta.env || {}
const minutes = (v: any, fallback: any) => {
  const n = Number(v)
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60 * 1000
}

// 운영 중 조정될 값이라 상수 한 곳에 모으고 env 로도 덮을 수 있게 둔다.
//
// 유휴가 지나면 로그아웃하지 않고 조작을 잠근다(S15P11E101-653).
// 최소 1시간은 열어 둔다 — 관제자가 자리에서 화면만 지켜보는 시간이 길고, 그때마다
// 비밀번호를 다시 치게 만들면 잠금이 로그아웃과 다를 바 없어진다.
// 자리를 확실히 뜰 때는 사용자 메뉴의 '조작 잠그기'로 즉시 잠글 수 있다.
export const IDLE_MS = minutes(env.VITE_SESSION_IDLE_MIN, 60)
export const WARN_MS = minutes(env.VITE_SESSION_WARN_MIN, 2)

// 잠긴 채로 이 시간을 넘기면 그때는 실제로 로그아웃한다.
// 근무는 교대된다 — 앞 근무자의 세션이 다음 날까지 남아 있으면 안 된다.
export const LOCK_MAX_MS = minutes(env.VITE_SESSION_LOCK_MAX_MIN, 12 * 60)

// access 만료 이 시간 전부터는 선제로 갱신한다(S15P11E101-613).
// 만료된 뒤 401 을 받고 나서 갱신해도 되지만, 그러면 그 요청 한 번이 왕복 두 번이 된다.
// access 수명이 1시간(608)이라 5분 여유는 충분히 짧고, 절전에서 깨어난 직후에도
// 5초 주기 감시가 곧바로 잡아낸다.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

// 다만 access 수명이 그보다 짧으면(테스트·짧은 수명 설정) 발급 즉시 갱신 조건이 서서
// 갱신이 끝없이 반복된다. 수명의 절반을 넘지 않게 잘라 준다.
/**
 * @param {number | null | undefined} expiresInSec 그때 받은 access 수명(초)
 * @returns {number} 선제 갱신 여유(ms)
 */
export function refreshMargin(expiresInSec: number | null | undefined) {
  const life = Number(expiresInSec) * 1000
  if (!Number.isFinite(life) || life <= 0) return REFRESH_MARGIN_MS
  return Math.min(REFRESH_MARGIN_MS, life / 2)
}

// STOMP 가 인증을 거부한 뒤 재연결을 기다려 주는 시간(S15P11E101-627).
// 갱신을 한 번 했는데도 계속 거부되면 서버 쪽 문제일 수 있다 — 몇 초짜리 딸꾹질에
// 관제 화면을 로그인으로 보내면 야간 무인 시간대에 감시가 끊긴다. 이 시간이 지나도
// 붙지 못하면 그때 로그아웃한다.
const secs = (v: any, fallback: number) => {
  const n = Number(v)
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 1000
}
export const STOMP_AUTH_GRACE_MS = secs(env.VITE_STOMP_AUTH_GRACE_SEC, 20)

export const ACTIVITY_KEY = 'bbiyong.activity'
// 잠금 시작 시각. 새로고침해도 풀리면 안 되므로 저장소에 남긴다 —
// 새로고침 한 번으로 열리는 잠금은 잠금이 아니다. 탭 사이에서도 같은 상태를 본다.
export const LOCK_KEY = 'bbiyong.lockedAt'

/**
 * 자동 로그아웃 사유. as const 로 리터럴을 고정해 오타·미정의 값을 빌드에서 막는다.
 * (JSDoc 으로 적혀 있던 것을 TS 문법으로 옮긴다 — .ts 에서는 JSDoc 이 무시된다)
 */
export const REASON = {
  IDLE: 'idle',        // 장시간 활동 없음
  EXPIRED: 'expired',  // 토큰 수명 만료
  MANUAL: 'manual',    // 사용자가 직접 로그아웃
} as const

export const REASON_TEXT: Record<string, string> = {
  // 유휴만으로는 더 이상 로그아웃하지 않는다(잠금으로 바뀜). 잠긴 채 상한을 넘겼을 때만 쓴다.
  [REASON.IDLE]: '장시간 잠금 상태가 이어져 로그아웃되었습니다. 다시 로그인해 주세요.',
  [REASON.EXPIRED]: '세션이 만료되어 로그아웃되었습니다. 다시 로그인해 주세요.',
}

/** @returns {number} 마지막 활동 시각(ms). 기록이 없으면 0 */
export function readActivity() {
  const raw = Number(localStorage.getItem(ACTIVITY_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** @param {number} [at] @returns {number} */
export function writeActivity(at: number = Date.now()) {
  localStorage.setItem(ACTIVITY_KEY, String(at))
  return at
}

export function clearActivity() { localStorage.removeItem(ACTIVITY_KEY) }

/** 잠긴 시각(ms). 잠겨 있지 않으면 0 */
export function readLockedAt() {
  const raw = Number(localStorage.getItem(LOCK_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}
export function writeLockedAt(at: number = Date.now()) {
  localStorage.setItem(LOCK_KEY, String(at))
  return at
}
export function clearLockedAt() { localStorage.removeItem(LOCK_KEY) }

// 잠긴 채로 얼마나 더 버틸 수 있는가(ms). 잠겨 있지 않으면 Infinity.
export function lockRemaining(now: number = Date.now(), at = readLockedAt()) {
  return at ? at + LOCK_MAX_MS - now : Infinity
}

// 남은 시간(ms). 활동 기록이 없으면 방금 활동한 것으로 본다 — 기록 이전의 세션을
// 곧바로 만료시키면 배포 직후 로그인해 있던 사용자가 이유 없이 튕긴다.
/**
 * @param {number} [now]
 * @param {number} [last]
 * @returns {number} 남은 ms. 0 이하면 만료
 */
export function idleRemaining(now: number = Date.now(), last = readActivity()) {
  if (!last) return IDLE_MS
  return last + IDLE_MS - now
}

// 절대 만료까지 남은 시간(ms). expiresAt 이 없으면(mock 모드) 만료하지 않는다.
/**
 * @param {number | null | undefined} expiresAt
 * @param {number} [now]
 * @returns {number} 남은 ms. expiresAt 이 없으면 Infinity
 */
export function absoluteRemaining(expiresAt: number | null | undefined, now: number = Date.now()) {
  return expiresAt ? expiresAt - now : Infinity
}
