// STOMP 연결 관리 — 앱 전체가 커넥션 하나를 공유한다.
//
// 구독은 연결 성립 전에도 등록할 수 있어야 한다(컴포넌트 마운트 순서와 무관해야 하므로).
// 등록된 구독을 자체 레지스트리에 들고 있다가, 연결이 맺어질 때마다 다시 SUBSCRIBE 한다.
// → 재연결 후에도 구독이 알아서 복구된다.

import { Client } from '@stomp/stompjs'
import { WS_URL } from './config.ts'

let client = null
let connected = false
let lastError = null
let authError = false
let nextId = 0
let token = null

const registry = new Map()      // id -> { destination, handler }
const active = new Map()        // id -> StompSubscription
const stateListeners = new Set<(snap: {
  connected: boolean, lastError: string | null, authError: boolean, hasToken: boolean,
}) => void>()

function emitState() {
  const snap = { connected, lastError, authError, hasToken: !!token }
  stateListeners.forEach((fn) => fn(snap))
}

// 서버 payload는 전부 JSON — 파싱 실패 시 원문을 넘겨 핸들러가 판단하게 둔다.
function parse(message: any) {
  try { return JSON.parse(message.body) } catch { return message.body }
}

function subscribeNow(id: any, entry: any) {
  if (!client || !client.connected) return
  active.set(id, client.subscribe(entry.destination, (m: any) => {
    try { entry.handler(parse(m)) } catch (e) { console.error('[stomp] handler error', entry.destination, e) }
  }))
}

function ensureClient() {
  if (client) return client
  client = new Client({
    brokerURL: WS_URL,
    reconnectDelay: 2000,
    heartbeatIncoming: 10000,
    heartbeatOutgoing: 10000,
    // CONNECT 프레임 인증 (가이드 §1) — 매 (재)연결 시 최신 토큰을 싣는다.
    beforeConnect: () => {
      client.connectHeaders = token ? { Authorization: `Bearer ${token}` } : {}
    },
    onConnect: () => {
      active.clear()
      registry.forEach((entry, id) => subscribeNow(id, entry))
      connected = true; lastError = null; authError = false; emitState()
    },
    onWebSocketClose: () => {
      active.clear()
      if (connected) { connected = false; emitState() }
    },
    onStompError: (frame) => {
      // 토큰 누락/만료 시 서버가 ERROR 프레임으로 연결을 거부한다.
      connected = false
      const msg = frame?.headers?.message || 'STOMP 프로토콜 오류'
      authError = /auth|token|unauthor|forbidden|jwt/i.test(msg)
      lastError = authError ? `인증 거부 — ${msg}` : msg
      emitState()
    },
    onWebSocketError: () => {
      lastError = '웹소켓 연결 실패'
      emitState()
    },
  })
  return client
}

// accessToken 은 STOMP CONNECT 헤더에 실린다(가이드 §1).
// 연결 수명주기와 분리해 둔다 — disconnect()가 비동기라, 연결 관리와 토큰 관리를 한데 묶으면
// deactivate() 완료가 늦게 도착하면서 이미 설정된 새 토큰을 지워버린다.
export function setToken(accessToken: any = null) {
  if (token === accessToken) return
  token = accessToken
  // 연결 중이면 끊어서 재연결시킨다 → beforeConnect 에서 새 토큰으로 CONNECT
  if (client && client.connected) client.forceDisconnect()
  emitState()
}

export function connect() {
  const c = ensureClient()
  if (!c.active) c.activate()
}

export async function disconnect() {
  if (!client) return
  registry.clear(); active.clear()
  await client.deactivate()
  connected = false; lastError = null; authError = false; emitState()
}

// destination 구독. 반환값을 호출하면 해제된다.
export function subscribe(destination: any, handler: any) {
  const id = ++nextId
  const entry = { destination, handler }
  registry.set(id, entry)
  subscribeNow(id, entry)
  return () => {
    registry.delete(id)
    const sub = active.get(id)
    if (sub) { try { sub.unsubscribe() } catch { /* 이미 끊긴 커넥션 */ } active.delete(id) }
  }
}

// 연결 전이면 조용히 버린다 — 제어 명령은 뒤늦게 도착하면 오히려 위험하다.
export function publish(destination: any, body: any) {
  if (!client || !client.connected) {
    console.warn('[stomp] 미연결 상태 — 발행 취소', destination)
    return false
  }
  client.publish({ destination, body: JSON.stringify(body) })
  return true
}

export function onState(fn: any) {
  stateListeners.add(fn)
  fn({ connected, lastError, authError, hasToken: !!token })
  return () => stateListeners.delete(fn)
}
