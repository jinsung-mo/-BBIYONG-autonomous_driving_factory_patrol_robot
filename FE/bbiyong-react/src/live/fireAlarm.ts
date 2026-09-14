import { useSyncExternalStore } from 'react'

// 화재 경보의 "확인되지 않음" 상태 (S15P11E101-643).
//
// 토스트는 떴다 사라지는 알림이지만, 화재는 누군가 봤다는 것이 확인되기 전까지
// 화면에 남아 있어야 한다. 그 미확인 상태를 여기에 둔다.
//
// - 컴포넌트 밖(모듈 레벨)에 두는 이유: 관제/운영/설정 탭을 오가도, EventAlert 가
//   다시 마운트돼도 같은 상태를 봐야 한다.
// - sessionStorage 에 남기는 이유: 서버 경보는 one-shot 이라(가이드 §4) 새로고침하면
//   /topic/alerts 수신분이 사라진다. 그 사이 미확인 화재가 조용히 묻히면 안 된다.
//   탭을 닫으면 지워지는 sessionStorage 가 맞다 — 다음 근무자의 브라우저까지 따라가면
//   이미 처리된 화재로 화면이 붉어진다.

const KEY = 'bbiyong.fireAlarm'
// 확인 이력은 무한정 쌓일 이유가 없다. 중복 발화만 막으면 되므로 최근 것만 남긴다.
const SEEN_MAX = 50

interface FireAlarmState {
  /** 아직 확인되지 않은 화재 경보 키 */
  pending: string[]
  /** 이미 한 번 다뤄본 경보 키 — 같은 경보로 다시 점멸하지 않게 한다 */
  seen: string[]
}

const EMPTY: FireAlarmState = { pending: [], seen: [] }

function read(): FireAlarmState {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return EMPTY
    const v = JSON.parse(raw)
    return {
      pending: Array.isArray(v?.pending) ? v.pending.map(String) : [],
      seen: Array.isArray(v?.seen) ? v.seen.map(String) : [],
    }
  } catch {
    // 저장소가 막힌 브라우저(사생활 보호 모드 등) — 메모리 상태만으로 동작한다
    return EMPTY
  }
}

let state: FireAlarmState = read()
const listeners = new Set<() => void>()

function commit(next: FireAlarmState) {
  state = next
  try { sessionStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 저장 실패해도 화면은 그대로 */ }
  listeners.forEach((fn) => fn())
}

/**
 * 화재 경보를 미확인 상태로 올린다. 같은 키로 두 번 부르면 무시한다 —
 * 구독 재연결이나 재렌더로 같은 경보가 다시 들어와도 확인한 경보가 되살아나면 안 된다.
 */
export function raiseFire(key: string) {
  const k = String(key)
  if (state.pending.includes(k) || state.seen.includes(k)) return
  commit({ pending: [...state.pending, k], seen: [...state.seen, k].slice(-SEEN_MAX) })
}

/**
 * 관제자가 [확인]을 눌렀다. 지금까지 올라온 화재를 확인 처리한다.
 * 이벤트 상태(UNRESOLVED)는 건드리지 않는다 — 확인은 "봤다"이지 "처리했다"가 아니다.
 */
export function acknowledgeFire() {
  if (state.pending.length === 0) return
  commit({ pending: [], seen: state.seen })
}

// 로그아웃해도 지우지 않는다. 확인하지 않은 화재는 계정이 바뀌었다고 없던 일이 되지 않는다 —
// 교대한 관제자에게도 보여야 한다. 탭을 닫으면 sessionStorage 와 함께 사라진다.

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => state
/** SSR 경로는 없지만 useSyncExternalStore 가 요구한다 */
const serverSnapshot = () => EMPTY

/** 미확인 화재가 있는가 — 점멸 여부를 이 값 하나로 판단한다 */
export function useFireUnacknowledged(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot().pending.length > 0, () => false)
}

/** 경보 한 건의 안정적인 키. 재연결로 같은 경보가 다시 와도 같은 값이 나와야 한다. */
export function fireKey(a: any): string {
  const id = a?.eventId ?? a?.id
  if (id != null) return `id:${id}`
  if (a?.timestamp) return `ts:${a.timestamp}:${a.robotId || ''}`
  return `local:${a?._id ?? ''}`
}
