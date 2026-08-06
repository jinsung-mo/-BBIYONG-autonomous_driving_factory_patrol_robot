// S15P11E101-436 검증용 가짜 백엔드.
// 실서버/실로봇에 DRIVE 를 쏘지 않고 발행 주기만 계측하려고 로컬에 STOMP 를 흉내낸다.
// - POST /api/auth/login  → accessToken 발급 (live 모드 진입용)
// - WS  /ws/control       → STOMP CONNECT 수락, SEND 프레임을 타임스탬프와 함께 기록
import http from 'node:http'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  // 실서버 SecurityConfig 와 동일하게 맞춘다 — PATCH 를 빼면 프리플라이트가 막힌다
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
}

// 이벤트 이력 더미 — 화재 8 / 과열 9 / 시스템 8, 어제~오늘로 흩어 놓는다
const EVENTS = Array.from({ length: 25 }, (_, i) => {
  const type = ['FIRE', 'OVERHEAT', 'SYSTEM'][i % 3]
  const ts = new Date(Date.UTC(2026, 6, 29, 10, 0, 0) + i * 37 * 60000).toISOString()
  return {
    eventId: 1000 + i, type, robotId: i % 3 === 2 ? 'orinka_02' : 'orinka_01',
    level: type === 'FIRE' ? 'CRITICAL' : 'WARNING',
    equipmentId: type === 'OVERHEAT' ? ['panel_A', 'panel_B', 'panel_C'][i % 3] : undefined,
    location: { x: 1.5 + i * 0.1, y: 0.8 },
    confidence: type === 'FIRE' ? 0.9 : undefined,
    temperature: type === 'OVERHEAT' ? 55 + i : undefined,
    timestamp: ts, status: 'UNRESOLVED',
  }
})

// 이벤트 영상 더미 (S15P11E101-628). 화재 이벤트에만 클립이 붙는 것으로 둔다 —
// 로봇이 화재 확정 시에만 클립을 올린다(BE_robot S15P11E101-631).
const CLIPS = [
  { id: 'clip-1', robotId: 'orinka_01', eventId: 1000, clipType: 'FIRE',
    durationSec: 12, thumbnailUrl: null, startedAt: '2026-07-29T10:00:00Z' },
  { id: 'clip-2', robotId: 'orinka_01', eventId: 1000, clipType: 'EVENT',
    durationSec: 8, thumbnailUrl: null, startedAt: '2026-07-29T10:00:20Z' },
  { id: 'clip-3', robotId: 'orinka_01', eventId: 1003, clipType: 'FIRE',
    durationSec: 15, thumbnailUrl: null, startedAt: '2026-07-29T11:51:00Z' },
]
const videosOf = (eventId) => CLIPS.filter((c) => c.eventId === eventId)
// 진짜 mp4 는 필요 없다 — Range 응답과 blob 재생 경로만 확인하면 된다
const CLIP_BYTES = Buffer.alloc(64 * 1024, 7)
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')

// 흑백 도면 PNG 생성기 (S15P11E101-676).
// 서버 도면은 흰 배경(#FFFFFF) + 검은 벽(#000000) 인 순수 흑백이다. 압출 렌더러가
// '밝기<128' 로 벽을 가리므로, 검증에도 같은 성질의 그림이 필요하다.
// 의존성 없이 8비트 흑백 PNG 를 직접 만든다.
function grayPng(w, h, pixels) {
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc = (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cr])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8bit grayscale
  // 스캔라인마다 필터 바이트 0 을 앞에 붙인다
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0
    pixels.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 방 몇 개와 복도가 있는 도면. 벽 두께는 균일하고 직각이다 — 실제 정제 도면과 같은 성질.
export function makeFloorplan(w = 320, h = 240) {
  const px = Buffer.alloc(w * h, 255)          // 흰 바닥
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = 0 }
  const rect = (x0, y0, x1, y1, t = 3) => {
    for (let d = 0; d < t; d++) {
      for (let x = x0; x <= x1; x++) { set(x, y0 + d); set(x, y1 - d) }
      for (let y = y0; y <= y1; y++) { set(x0 + d, y); set(x1 - d, y) }
    }
  }
  const sx = w / 320, sy = h / 240
  const R = (a, b, c, d) => rect(Math.round(a * sx), Math.round(b * sy), Math.round(c * sx), Math.round(d * sy), Math.max(3, Math.round(3 * sx)))
  R(6, 6, 314, 234)                             // 외벽
  R(30, 30, 130, 110)                           // 방 1
  R(150, 30, 250, 110)                          // 방 2
  R(30, 140, 130, 210)                          // 방 3
  R(170, 140, 290, 210)                         // 방 4
  return grayPng(w, h, px)
}

// 위 도면을 활성 도면으로 쓰는 메타.
export function floorplanDetail(imageBytes, id = 'fp1') {
  return {
    id, name: '정제 도면', imageUrl: `/api/maps/${id}/image`,
    widthPx: 320, heightPx: 240, resolution: 0.05,
    originX: -2.0, originY: -1.5, originYaw: 0,
    active: true, kind: 'FLOORPLAN', imageBytes,
  }
}

export function startFakeBackend(port = 8099) {
  // 다른 작업이 이미 8099 를 쓰고 있으면 검증 전체가 EADDRINUSE 로 죽는다.
  // 스크립트를 하나하나 고치는 대신 환경변수 하나로 전부 옮길 수 있게 한다.
  if (process.env.FAKE_PORT) port = Number(process.env.FAKE_PORT)
  const sends = []          // { t, destination, body }
  const restCalls = []      // { url, type, page, size, returned }
  const subs = []           // { id, destination, socket }
  let t0 = null             // 첫 SEND 기준 시각
  let msgId = 0

  // 맵 아카이브 (S15P11E101-483). 로봇이 SAVE_MAP 을 처리해 업로드한 결과를 흉내낸다.
  const maps = []
  let activateImplemented = false   // 활성 맵 지정 API 가 서버에 있는지 — 미구현이면 404
  let activeId = null
  // 인증 개편(S15P11E101-608): access 1시간 · refresh 30일. 613 검증을 위해 짧게 줄여 쓴다.
  let expiresIn = 3600              // 로그인 응답의 access 수명(초)
  let legacyAuth = false            // true 면 refreshToken 을 주지 않는다(구버전 서버 재현)
  let tokenSeq = 0
  const liveAccess = new Set()      // 아직 유효한 access 토큰
  const liveRefresh = new Set()     // 아직 유효한 refresh 토큰
  let refreshCalls = 0
  let lastRole = 'ROLE_ADMIN'
  let lastEmail = ''
  let withEquipment = true   // 630 이전 서버(설비 집계 없음)를 흉내내려면 false
  // 로그인 비밀번호 검사(S15P11E101-653). 기본은 끔 — 기존 검증 스크립트들이 아무 값이나
  // 쓰고 있어 켜 두면 전부 깨진다. 잠금 해제처럼 '틀린 비밀번호'가 필요한 곳에서만 켠다.
  let checkPassword = false
  const PASSWORD = 'password'
  // 사용자 관리(S15P11E101-614). 실서버 UserSummaryResponse 와 같은 모양.
  const users = [
    { id: 1, email: 'test@bbiyong.io', name: 'E101 관리자', role: 'ROLE_ADMIN' },
    { id: 2, email: 'viewer@bbiyong.io', name: '김뷰어', role: 'ROLE_USER' },
    { id: 3, email: 'night@bbiyong.io', name: '야간 담당', role: 'ROLE_USER' },
  ]
  // 발급한 access 토큰이 어떤 역할인지 기억한다 — 403 판정에 쓴다
  const tokenRole = new Map()
  // 조종 점유(S15P11E101-779)는 소유자를 email(principal 이름)로 알린다 — 토큰마다 기억해 둔다
  const tokenEmail = new Map()
  const issue = (email, role) => {
    tokenSeq++
    const access = `fake-access-${tokenSeq}`
    liveAccess.add(access)
    tokenRole.set(access, role)
    tokenEmail.set(access, String(email || '').toLowerCase())
    const out = { tokenType: 'Bearer', accessToken: access, expiresIn, role }
    if (!legacyAuth) {
      const refresh = `fake-refresh-${tokenSeq}`
      liveRefresh.add(refresh)
      out.refreshToken = refresh
    }
    return out
  }
  let rejectAuth = false            // true 면 인가 필요한 조회에 401 을 돌려준다
  let failNext = 0                  // >0 이면 그 횟수만큼 500 을 돌려준다 (서버 오류 재현)
  let robotOnline = true            // GET /api/robots 가 보고할 로봇 가동 여부
  const drive = { maxLinear: 0.5, maxAngular: 0.5 }  // 주행 상한 — BE 기본값과 동일 (S15P11E101-515)
  // 활성 도면 (S15P11E101-524). imageBytes 는 /api/maps/{id}/image 로 서빙한다.
  let activePlan = null
  // 관제센터 신규 API 상태
  let notify = {
    id: 1, userId: 'test@bbiyong.io', mattermostEnabled: false,
    mattermostWebhookUrl: null, mattermostChannel: null, minSeverity: 'WARNING',
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  }
  const schedules = [{
    scheduleId: 1, name: '야간 순찰', robotId: 'orinka_01',
    cronExpression: '0 0 20 * * *', enabled: true,
    lastExecuted: '2026-07-31T11:00:00Z',
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  }]
  schedules.push({
    scheduleId: 2, name: '2호기 심야 점검', robotId: 'orinka_02',
    cronExpression: '0 0 2 * * *', enabled: false, lastExecuted: null,
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  })
  let schSeq = 2
  const waypoints = []              // 순찰 지점 (S15P11E101-514)
  // 서버 설정과 같은 카메라 가동범위(bbiyong.camera.tilt-min/max)
  const cameraTiltMin = -30
  const cameraTiltMax = 45
  let rejectStompAuth = false      // CONNECT 를 인증 거부시킨다(627 검증)
  const wsSockets = new Set()
  let lastConnect = null
  let wpSeq = 0
  // 로봇(MR !250)이 경로에 stamp 하는 저장맵 scouting 세션. 활성 맵을 바꾸면 새 세션이 된다.
  let activeMapSession = 1
  let routeSession = 0        // 마지막으로 하달된 경로가 어느 세션인지
  let patrolRunning = false
  // 설비(분전반) — BE seedDefaults 와 동일 (S15P11E101-525)
  const equipments = [
    { equipmentId: 'panel_A', name: 'A구역 분전반', x: 8.5, y: 3.1, threshold: 55.0,
      lastTemperature: 41.2, lastInspectedAt: '2026-07-31T02:10:00Z', status: 'NORMAL' },
    { equipmentId: 'panel_B', name: 'B구역 분전반', x: 12.8, y: 14.2, threshold: 55.0,
      lastTemperature: 61.4, lastInspectedAt: '2026-07-31T02:12:00Z', status: 'OVER' },
    { equipmentId: 'panel_C', name: 'C구역 분전반', x: 3.2, y: 9.7, threshold: 55.0,
      lastTemperature: null, lastInspectedAt: null, status: 'UNKNOWN' },
  ]

  // 구독 중인 클라이언트에 MESSAGE 프레임을 밀어 넣는다 (텔레메트리·경보 흉내)
  // 매핑 진행 상태 (S15P11E101-744). REST 복원과 STOMP 전환이 같은 값을 봐야 한다 —
  // 둘이 어긋나면 새로고침할 때마다 화면이 튄다.
  let mappingPhase = 'IDLE'
  let gridImplemented = true
  // 768 검증용 — 응답을 갈아 끼워 '충전 중'·'자료 없음' 같은 상태를 만든다
  let statsOverheat = null
  let statsWeekly = null
  let statsBattery = null
  let zones = []

  function push(destination, payload, filter = null) {
    let n = 0
    subs.filter((s) => s.destination === destination && (!filter || filter(s))).forEach((s) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      sendText(s.socket, `MESSAGE\nsubscription:${s.id}\nmessage-id:${++msgId}\n`
        + `destination:${destination}\ncontent-type:application/json\n\n${body}`)
      n++
    })
    return n
  }

  // ---- 조종 점유 (S15P11E101-778 · 779 / BE MR !344) ----
  // ControlOwnershipService 를 그대로 흉내낸다. 실서버와 다른 점은 없어야 한다 —
  // 리스 2초, 500ms 스윕(만료 처리 + HEARTBEAT), 암묵 획득, 명시적 TAKEOVER, 세션 종료 시 해제.
  const LEASE_MS = 2000
  const ROBOT_DEFAULT = 'orinka_01'
  /** socket → { sessionId, email, role } */
  const socketMeta = new Map()
  /** robotId → { sessionId, email, expiresAt } */
  const leases = new Map()
  let sessSeq = 0
  // Spring simple broker 가 CONNECTED 에 session 헤더를 실어 줄지 확실하지 않다.
  // 기본은 '안 실어 준다'(비관적) — FE 가 ACQUIRE 왕복으로 자기 sessionId 를 학습하는
  // 경로를 그대로 검증하기 위해서다. FAKE_STOMP_SESSION_HEADER=1 이면 실어 준다.
  const sendSessionHeader = process.env.FAKE_STOMP_SESSION_HEADER === '1'

  const liveLease = (robotId) => {
    const l = leases.get(robotId)
    if (!l) return null
    return l.expiresAt > Date.now() ? l : null
  }

  function broadcastControl(robotId, event) {
    const now = Date.now()
    const l = liveLease(robotId)
    // 실서버는 JSON 문자열을 그대로 body 에 싣는다 — FE 의 파싱 경로를 같게 만든다
    return push(`/topic/control/${robotId}`, JSON.stringify({
      robotId, event,
      owner: l ? l.sessionId : null,
      ownerEmail: l ? l.email : null,
      leftMs: l ? Math.max(0, l.expiresAt - now) : 0,
      serverTime: now,
    }))
  }

  /** 거부 사유는 요청자 '계정'에게 간다 — Spring user destination 과 같이 같은 계정의 모든 탭이 받는다. */
  function notifyDenied(email, robotId, reason) {
    if (!email) return 0
    const now = Date.now()
    const l = liveLease(robotId)
    return push('/user/queue/control', JSON.stringify({
      type: 'CONTROL_DENIED', robotId, reason,
      owner: l ? l.sessionId : null,
      ownerEmail: l ? l.email : null,
      leftMs: l ? Math.max(0, l.expiresAt - now) : 0,
      serverTime: now,
    }), (s) => socketMeta.get(s.socket)?.email === email)
  }

  /** 탈취·강제해제 시 정지 프레임 1회. 로봇이 없으므로 기록만 남긴다. */
  function forceStop(robotId) {
    sends.push({
      t: t0 === null ? 0 : Date.now() - t0, at: Date.now(),
      destination: '(server)', body: JSON.stringify({ command: 'DRIVE', linear: 0, angular: 0 }),
      relayed: true, reason: `점유 전환 정지 프레임 (${robotId})`,
      payload: { command: 'DRIVE', linear: 0, angular: 0 },
    })
  }

  /** ControlOwnershipService.claim — ACQUIRED | RENEWED | TAKEN_OVER | DENIED */
  function claimOwnership(robotId, sessionId, email, takeover) {
    const now = Date.now()
    const prev = leases.get(robotId)
    const alive = prev && prev.expiresAt > now
    if (alive && prev.sessionId !== sessionId && !takeover) return 'DENIED'

    let decision
    if (alive && prev.sessionId === sessionId) decision = 'RENEWED'
    else if (alive) decision = 'TAKEN_OVER'
    else decision = 'ACQUIRED'

    leases.set(robotId, { sessionId, email, expiresAt: now + LEASE_MS })
    if (decision === 'TAKEN_OVER') {
      forceStop(robotId)
      notifyDenied(prev.email, robotId, 'TAKEN_OVER_BY_OTHER')
    }
    if (decision !== 'RENEWED') broadcastControl(robotId, decision)
    return decision
  }

  function releaseOwnership(robotId, sessionId) {
    const cur = leases.get(robotId)
    if (!cur || cur.sessionId !== sessionId) return false
    leases.delete(robotId)
    broadcastControl(robotId, 'RELEASED')
    return true
  }

  function releaseAllForSession(sessionId) {
    if (!sessionId) return
    for (const [robotId, l] of [...leases]) {
      if (l.sessionId !== sessionId) continue
      leases.delete(robotId)
      forceStop(robotId)
      broadcastControl(robotId, 'DISCONNECTED')
    }
  }

  // 500ms 스윕 — 만료 제거 + 살아 있는 리스에 HEARTBEAT.
  // 점유가 비어 있으면 아무것도 보내지 않는다(실서버와 동일). FE 는 STATUS 로 공백을 메운다.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [robotId, l] of [...leases]) {
      if (l.expiresAt <= now) { leases.delete(robotId); broadcastControl(robotId, 'EXPIRED') }
      else broadcastControl(robotId, 'HEARTBEAT')
    }
  }, 500)
  sweep.unref?.()

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
    // 서버 오류 재현 — 지정한 횟수만큼 500
    if (failNext > 0 && !req.url.startsWith('/api/auth/')) {
      failNext--
      restCalls.push({ url: req.url, method: req.method, failed: true })
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: '서버 내부 오류가 발생했습니다.' }))
      return
    }
    // 만료·폐기된 access 로 인가 API 를 부르면 401 (S15P11E101-613 검증용).
    // 헤더가 아예 없으면 예전처럼 통과시킨다 — 다른 검증 스크립트가 토큰 없이 부른다.
    if (!req.url.startsWith('/api/auth/')) {
      const auth = req.headers.authorization || ''
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null
      // 기준은 '발급한 적이 있는가'다. liveAccess 가 비었다는 것은 모두 만료됐다는 뜻이지
      //  검사를 끄라는 뜻이 아니다 — 처음엔 size 로 봤다가 만료 재현이 통째로 무력화됐다.
      if (tok && tokenSeq > 0 && !liveAccess.has(tok)) {
        restCalls.push({ url: req.url, method: req.method, expired: true })
        res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: '토큰이 만료되었습니다.' }))
        return
      }
    }
    // 토큰이 죽은 상황 재현 — 인증 없는 /api/auth/* 를 뺀 나머지에 401
    if (rejectAuth && !req.url.startsWith('/api/auth/')) {
      restCalls.push({ url: req.url, method: req.method, rejected: true })
      res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: '토큰이 만료되었습니다.' }))
      return
    }
    // 이벤트 상세 + 연관 영상 (S15P11E101-628)
    const evVideo = req.url.match(/^\/api\/events\/(\d+)\/video$/)
    if (evVideo && req.method === 'GET') {
      restCalls.push({ url: req.url, method: 'GET' })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(videosOf(Number(evVideo[1]))))
      return
    }
    const evDetail = req.url.match(/^\/api\/events\/(\d+)$/)
    if (evDetail && req.method === 'GET') {
      restCalls.push({ url: req.url, method: 'GET' })
      const ev = EVENTS.find((e) => String(e.eventId) === evDetail[1])
      if (!ev) {
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: '이벤트를 찾을 수 없습니다.' }))
        return
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...ev, videos: videosOf(ev.eventId) }))
      return
    }
    // 영상 스트림 — Range 가 오면 206 으로 부분 응답한다(실서버 VideoController 와 동일)
    const vStream = req.url.match(/^\/api\/videos\/([^/?]+)\/stream/)
    if (vStream && req.method === 'GET') {
      const clip = CLIP_BYTES
      const range = req.headers.range
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? Number(m[1]) : 0
        const end = m && m[2] ? Number(m[2]) : clip.length - 1
        const chunk = clip.subarray(start, end + 1)
        restCalls.push({ url: req.url, method: 'GET', range, partial: true })
        res.writeHead(206, {
          ...CORS,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${clip.length}`,
          'Content-Length': String(chunk.length),
        })
        res.end(chunk)
        return
      }
      restCalls.push({ url: req.url, method: 'GET', partial: false })
      res.writeHead(200, {
        ...CORS, 'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes', 'Content-Length': String(clip.length),
      })
      res.end(clip)
      return
    }
    const vThumb = req.url.match(/^\/api\/videos\/([^/?]+)\/thumbnail/)
    if (vThumb && req.method === 'GET') {
      restCalls.push({ url: req.url, method: 'GET' })
      res.writeHead(200, { ...CORS, 'Content-Type': 'image/png', 'Content-Length': String(PNG_1PX.length) })
      res.end(PNG_1PX)
      return
    }
    // 이벤트 해결 처리 (S15P11E101-593) — PATCH /api/events/{eventId} { status }
    const evPatch = req.url.match(/^\/api\/events\/(\d+)$/)
    if (evPatch && req.method === 'PATCH') {
      let pb = ''
      req.on('data', (c) => { pb += c })
      req.on('end', () => {
        let body = null
        try { body = pb ? JSON.parse(pb) : null } catch { body = null }
        restCalls.push({ url: req.url, method: 'PATCH', body })
        const norm = typeof body?.status === 'string' ? body.status.trim().toUpperCase() : null
        if (norm !== 'UNRESOLVED' && norm !== 'RESOLVED') {
          res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: '유효하지 않은 status 입니다. (UNRESOLVED | RESOLVED)' }))
          return
        }
        const ev = EVENTS.find((e) => String(e.eventId) === evPatch[1])
        if (!ev) {
          res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: '이벤트를 찾을 수 없습니다.' }))
          return
        }
        ev.status = norm
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(ev))
      })
      return
    }
    // 이벤트 삭제 (S15P11E101-516) — DELETE /api/events/{eventId}, 없으면 404
    const evDel = req.url.match(/^\/api\/events\/([^/?]+)$/)
    if (evDel && req.method === 'DELETE') {
      restCalls.push({ url: req.url, method: 'DELETE' })
      const i = EVENTS.findIndex((e) => String(e.eventId) === decodeURIComponent(evDel[1]))
      if (i < 0) {
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: '이벤트를 찾을 수 없습니다.' }))
        return
      }
      EVENTS.splice(i, 1)
      res.writeHead(204, CORS)
      res.end()
      return
    }
    // 사용자 관리 (S15P11E101-614) — 관리자 전용. 비관리자에게는 403.
    if (req.url.startsWith('/api/admin/users')) {
      let ab = ''
      req.on('data', (c) => { ab += c })
      req.on('end', () => {
        let body = null
        try { body = ab ? JSON.parse(ab) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        const auth = req.headers.authorization || ''
        const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null
        // 서버가 최종 판단한다 — FE 가 버튼을 감추는 것과 별개다
        if (tokenRole.get(tok) !== 'ROLE_ADMIN') {
          res.writeHead(403, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: '접근 권한이 없습니다.' }))
          return
        }
        if (req.method === 'PATCH') {
          const email = String(body?.email || '')
          const role = String(body?.role || '')
          if (role !== 'ROLE_ADMIN' && role !== 'ROLE_USER') {
            res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: '유효하지 않은 role 입니다.' }))
            return
          }
          const u = users.find((x) => x.email.toLowerCase() === email.toLowerCase())
          if (!u) {
            res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: '사용자를 찾을 수 없습니다.' }))
            return
          }
          u.role = role
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify(u))
          return
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(users))
      })
      return
    }
    // ---- 관제센터 신규 API (FE_CONTROL_CENTER_API_GUIDE.md) ----
    // 이벤트 통계 — /api/events/stats/* . '/api/events' 목록보다 먼저 매칭해야 한다.
    const st = req.url.match(/^\/api\/events\/stats\/([a-z-]+)/)
    if (st) {
      const u = new URL(req.url, 'http://x')
      restCalls.push({ url: req.url, method: req.method })
      const kind = st[1]
      const mk = (label, timestamp, total, crit) => ({
        label, timestamp, totalCount: total, criticalCount: crit, warningCount: total - crit,
        unresolvedCount: Math.ceil(total / 2), resolvedCount: Math.floor(total / 2),
      })
      let groupBy = 'hour'
      let points = []
      if (kind === 'hourly') {
        const hours = Number(u.searchParams.get('hours') || 24)
        points = Array.from({ length: hours }, (_, i) => {
          const d = new Date(Date.now() - (hours - 1 - i) * 3600000)
          return mk(String(d.getHours()).padStart(2, '0') + ':00', d.toISOString(), (i * 7) % 5, (i * 3) % 2)
        })
      } else if (kind === 'daily') {
        groupBy = 'day'
        const days = Number(u.searchParams.get('days') || 7)
        points = Array.from({ length: days }, (_, i) => {
          const d = new Date(Date.now() - (days - 1 - i) * 86400000)
          return mk((d.getMonth() + 1) + '/' + d.getDate(), d.toISOString(), 3 + ((i * 5) % 9), (i * 2) % 3)
        })
      } else if (kind === 'by-robot') {
        groupBy = 'robot'
        points = [mk('orinka_01', null, 25, 5), mk('orinka_02', null, 12, 2)]
      } else if (kind === 'by-equipment') {
        groupBy = 'equipment'
        points = [mk('panel_A', null, 9, 1), mk('panel_B', null, 17, 4), mk('panel_C', null, 3, 0)]
      } else {
        groupBy = 'type'
        points = [mk('FIRE', null, 8, 8), mk('OVERHEAT', null, 21, 0), mk('SYSTEM', null, 6, 0)]
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        groupBy,
        startTime: new Date(Date.now() - 7 * 86400000).toISOString(),
        endTime: new Date().toISOString(),
        dataPoints: points,
      }))
      return
    }
    // 대시보드 요약 — GET /api/dashboard/stats
    if (req.url.startsWith('/api/dashboard/stats')) {
      restCalls.push({ url: req.url, method: req.method })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        summary: {
          totalRobots: 2, activeRobots: robotOnline ? 1 : 0, chargingRobots: 1,
          avgBattery: 78.5, onlineRobots: robotOnline ? 1 : 0,
        },
        today: {
          eventCount: EVENTS.length,
          criticalEvents: EVENTS.filter((e) => e.level === 'CRITICAL').length,
          warningEvents: EVENTS.filter((e) => e.level === 'WARNING').length,
          resolvedEvents: EVENTS.filter((e) => e.status === 'RESOLVED').length,
          unresolvedEvents: EVENTS.filter((e) => (e.status || 'UNRESOLVED') === 'UNRESOLVED').length,
        },
        // 설비 집계 (S15P11E101-573 · 630). 목록은 설정 탭이 쓰는 것과 같은 형태다.
        equipment: withEquipment ? {
          totalEquipments: equipments.length,
          overheatingEquipments: equipments.filter((e) => e.status === 'OVER').length,
          normalEquipments: equipments.filter((e) => e.status === 'NORMAL').length,
          unknownEquipments: equipments.filter((e) => e.status === 'UNKNOWN').length,
        } : undefined,
        equipmentStatus: withEquipment ? equipments : undefined,
        recentEvents: EVENTS.slice(0, 5),
        robotStatus: [{
          robotId: 'orinka_01', name: '오린카-01',
          status: robotOnline ? 'AUTO_PATROL' : 'OFFLINE',
          battery: 82, speed: 0.3, estop: 'RELEASED', commLatencyMs: 45, inferenceFps: 30,
          lastConnected: new Date().toISOString(),
          location: { x: 10.5, y: 20.3, yaw: 45 }, online: robotOnline,
        }, {
          // 2호기는 연결이 끊긴 상태 — 낡은 값을 지금 값처럼 보여주지 않는지 확인용
          robotId: 'orinka_02', name: '오린카-02', status: 'CHARGING',
          battery: 41, speed: 0, estop: 'ENGAGED', commLatencyMs: 210, inferenceFps: 11.5,
          lastConnected: '2026-08-01T09:12:00Z',
          location: { x: 2.1, y: 4.4, yaw: 0 }, online: false,
        }],
      }))
      return
    }
    // 로봇 건강 이력 — GET /api/robots/{id}/health-history . '/api/robots' 목록보다 먼저.
    const hh = req.url.match(/^\/api\/robots\/([^/?]+)\/health-history/)
    if (hh) {
      const u = new URL(req.url, 'http://x')
      const period = u.searchParams.get('period') || '24h'
      restCalls.push({ url: req.url, method: req.method, period })
      const SPAN = { '1h': [60, 60000], '6h': [72, 300000], '24h': [96, 900000], '7d': [84, 7200000], '30d': [90, 28800000] }
      const conf = SPAN[period] || SPAN['24h']
      const n = conf[0], step = conf[1]
      const end = Date.now()
      const dataPoints = Array.from({ length: n }, (_, i) => {
        // 중간에 통신이 끊긴 구간을 하나 만든다 — FE 가 선을 끊어 그리는지 보려는 것
        const online = !(i > n * 0.4 && i < n * 0.47)
        return {
          timestamp: new Date(end - (n - 1 - i) * step).toISOString(),
          battery: Math.round((100 - (i / n) * 45) * 10) / 10,
          speed: 0.3,
          commLatencyMs: 40 + Math.round(25 * Math.abs(Math.sin(i / 6))),
          inferenceFps: Math.round((28 + 4 * Math.sin(i / 4)) * 10) / 10,
          status: 'AUTO_PATROL', estop: 'NONE', online,
        }
      })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        robotId: decodeURIComponent(hh[1]),
        startTime: dataPoints[0].timestamp,
        endTime: dataPoints[dataPoints.length - 1].timestamp,
        dataPoints,
      }))
      return
    }
    // Mattermost 알림 설정 — GET/PUT /api/notifications/settings
    if (req.url.startsWith('/api/notifications/settings')) {
      let nb = ''
      req.on('data', (c) => { nb += c })
      req.on('end', () => {
        let body = null
        try { body = nb ? JSON.parse(nb) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        if (req.method === 'PUT') {
          notify = {
            ...notify,
            mattermostEnabled: !!body?.mattermostEnabled,
            mattermostWebhookUrl: body?.mattermostWebhookUrl ?? null,
            mattermostChannel: body?.mattermostChannel ?? null,
            minSeverity: body?.minSeverity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
            updatedAt: new Date().toISOString(),
          }
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(notify))
      })
      return
    }
    // 자동 순찰 스케줄 — /api/patrol-schedules
    if (req.url.startsWith('/api/patrol-schedules')) {
      const one = req.url.match(/^\/api\/patrol-schedules\/(\d+)/)
      let sb = ''
      req.on('data', (c) => { sb += c })
      req.on('end', () => {
        let body = null
        try { body = sb ? JSON.parse(sb) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        const bad = (m) => {
          res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: m }))
        }
        // 서버는 Spring CronExpression 으로 검증한다 — 6필드가 아니면 400
        const cronOk = (e) => typeof e === 'string' && e.trim().split(/\s+/).length === 6
        if (one) {
          const id = Number(one[1])
          const i = schedules.findIndex((x) => x.scheduleId === id)
          if (i < 0) {
            res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ message: '스케줄을 찾을 수 없습니다.' }))
            return
          }
          if (req.method === 'DELETE') {
            schedules.splice(i, 1)
            res.writeHead(204, CORS); res.end(); return
          }
          if (req.method === 'PUT') {
            if (!cronOk(body?.cronExpression)) { bad('잘못된 Cron 표현식입니다.'); return }
            schedules[i] = { ...schedules[i], ...body, scheduleId: id, updatedAt: new Date().toISOString() }
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
            res.end(JSON.stringify(schedules[i])); return
          }
        }
        if (req.method === 'POST') {
          if (!body?.name) { bad('스케줄 이름은 필수입니다.'); return }
          if (!cronOk(body?.cronExpression)) { bad('잘못된 Cron 표현식입니다.'); return }
          const row = {
            scheduleId: ++schSeq, name: body.name, robotId: body.robotId || 'orinka_01',
            cronExpression: body.cronExpression, enabled: body.enabled !== false,
            lastExecuted: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }
          schedules.push(row)
          res.writeHead(201, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify(row)); return
        }
        const su = new URL(req.url, 'http://x')
        const rid = su.searchParams.get('robotId')
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(schedules.filter((x) => !rid || x.robotId === rid)))
      })
      return
    }
    // 이벤트 이력 — Spring Page 형태. type 필터와 페이징을 실제처럼 흉내낸다.
    if (req.url.startsWith('/api/events')) {
      const u = new URL(req.url, 'http://x')
      const type = u.searchParams.get('type')
      const level = u.searchParams.get('level')
      const status = u.searchParams.get('status')
      const robotIdQ = u.searchParams.get('robotId')
      const equipmentIdQ = u.searchParams.get('equipmentId')
      const startDate = u.searchParams.get('startDate')
      const endDate = u.searchParams.get('endDate')
      const page = Number(u.searchParams.get('page') || 0)
      const size = Number(u.searchParams.get('size') || 10)
      const all = EVENTS.filter((e) => (!type || e.type === type)
        && (!level || e.level === level)
        && (!status || (e.status || 'UNRESOLVED') === status)
        && (!robotIdQ || e.robotId === robotIdQ)
        && (!equipmentIdQ || e.equipmentId === equipmentIdQ)
        && (!startDate || e.timestamp.slice(0, 10) >= startDate)
        && (!endDate || e.timestamp.slice(0, 10) <= endDate))
      const content = all.slice(page * size, page * size + size)
      restCalls.push({ url: req.url, type, page, size, returned: content.length })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        content,
        pageable: { pageNumber: page, pageSize: size },
        totalElements: all.length,
        totalPages: Math.ceil(all.length / size),
      }))
      return
    }
    // 구역 — S15P11E101-770. BE 계약(2026-08-06) 그대로.
    if (req.url.split('?')[0] === '/api/zones/resolve') {
      restCalls.push({ url: req.url, method: req.method })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ x: 0, y: 0, zoneId: null, zoneName: null, nearest: null, label: '(0.00, 0.00) m' }))
      return
    }
    if (req.url.split('?')[0] === '/api/zones/seed-grid' && req.method === 'POST') {
      restCalls.push({ url: req.url, method: req.method })
      const q = new URL(req.url, 'http://x').searchParams
      if (zones.length && q.get('replace') !== 'true') {
        res.writeHead(409, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: '이미 구역이 있습니다.' }))
        return
      }
      const rows = Number(q.get('rows') || 3)
      const cols = Number(q.get('cols') || 3)
      zones = []
      // 활성 도면 경계를 3x3 으로 자른다. A1 = 지도 좌상단.
      const x0 = -2.0
      const y0 = -1.5
      const w = 16.0
      const h = 12.0
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          zones.push({
            id: `z-${r}-${c}`,
            name: `구역 ${String.fromCharCode(65 + c)}${r + 1}`,
            x1: x0 + (w / cols) * c, y1: y0 + (h / rows) * (rows - 1 - r),
            x2: x0 + (w / cols) * (c + 1), y2: y0 + (h / rows) * (rows - r),
            createdAt: '2026-08-06T07:00:00Z',
          })
        }
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(zones))
      return
    }
    if (req.url.split('?')[0].startsWith('/api/zones')) {
      restCalls.push({ url: req.url, method: req.method })
      const id = req.url.split('?')[0].replace('/api/zones', '').replace('/', '')
      if (req.method === 'GET') {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(zones))
        return
      }
      if (req.method === 'DELETE' && id) {
        zones = zones.filter((z) => z.id !== id)
        res.writeHead(204, CORS); res.end(); return
      }
      if ((req.method === 'PUT' || req.method === 'POST')) {
        let raw = ''
        req.on('data', (d) => { raw += d })
        req.on('end', () => {
          let body = {}
          try { body = JSON.parse(raw || '{}') } catch { /* 빈 본문 */ }
          if (req.method === 'PUT' && id) {
            zones = zones.map((z) => (z.id === id ? { ...z, ...body, id } : z))
          } else {
            zones.push({ ...body, id: `z-new-${zones.length}` })
          }
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify(zones.find((z) => z.id === id) || zones[zones.length - 1]))
        })
        return
      }
    }
    // 통계 지표 3종 — S15P11E101-768. BE 계약(2026-08-06 확인) 그대로 흉내낸다.
    if (req.url.split('?')[0] === '/api/stats/overheat-equipment') {
      restCalls.push({ url: req.url, method: req.method })
      const days = Number(new URL(req.url, 'http://x').searchParams.get('days') || 7)
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(statsOverheat ?? {
        periodDays: days, totalCount: 5,
        items: [
          { equipmentId: 'panel_A', name: '분전반 A', count: 3, lastAt: '2026-08-06T05:12:34Z' },
          { equipmentId: 'panel_B', name: 'panel_B', count: 2, lastAt: '2026-08-05T22:01:10Z' },
        ],
      }))
      return
    }
    if (req.url.split('?')[0] === '/api/stats/alerts-weekly') {
      restCalls.push({ url: req.url, method: req.method })
      const days = Number(new URL(req.url, 'http://x').searchParams.get('days') || 7)
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(statsWeekly ?? {
        periodDays: days,
        items: [
          { date: '2026-07-31', fire: 0, overheat: 0, total: 0 },
          { date: '2026-08-01', fire: 1, overheat: 0, total: 1 },
          { date: '2026-08-02', fire: 0, overheat: 2, total: 2 },
          { date: '2026-08-03', fire: 0, overheat: 0, total: 0 },
          { date: '2026-08-04', fire: 2, overheat: 1, total: 3 },
          { date: '2026-08-05', fire: 0, overheat: 1, total: 1 },
          { date: '2026-08-06', fire: 2, overheat: 1, total: 3 },
        ],
      }))
      return
    }
    if (req.url.split('?')[0] === '/api/stats/battery-estimate') {
      restCalls.push({ url: req.url, method: req.method })
      const rid = new URL(req.url, 'http://x').searchParams.get('robotId')
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(statsBattery ?? {
        robotId: rid, battery: 68.0, dischargePerHour: 12.0,
        estimatedRemainingMinutes: 340, basisMinutes: 60,
      }))
      return
    }
    // 격자 메타 — GET /api/maps/active/grid (S15P11E101-745). 좌표 정합의 기준이다.
    // gridImplemented=false 로 두면 이 API 가 없는 서버를 흉내낸다.
    if (req.url.split('?')[0] === '/api/maps/active/grid') {
      restCalls.push({ url: req.url, method: req.method })
      if (!gridImplemented || !activePlan) {
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: '격자 메타가 없습니다.' }))
        return
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        cols: activePlan.widthPx, rows: activePlan.heightPx,
        cellResolution: activePlan.resolution,
        originX: activePlan.originX, originY: activePlan.originY,
        originYaw: activePlan.originYaw ?? 0,
      }))
      return
    }
    // 매핑 진행 상태 — GET /api/maps/status?robotId= (S15P11E101-744). '/{id}' 보다 먼저 매칭.
    if (req.url.split('?')[0] === '/api/maps/status') {
      restCalls.push({ url: req.url, method: req.method })
      const robotId = new URL(req.url, 'http://x').searchParams.get('robotId')
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        robotId, phase: mappingPhase, mapping: mappingPhase === 'MAPPING',
        since: '2026-08-05T20:00:00Z',
      }))
      return
    }
    // 활성 도면 조회 — GET /api/maps/active (S15P11E101-524). '/{id}' 보다 먼저 매칭.
    if (req.url.split('?')[0] === '/api/maps/active') {
      restCalls.push({ url: req.url, method: req.method })
      if (!activePlan) {
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: '활성 맵이 없습니다.' }))
        return
      }
      const { imageBytes, ...detail } = activePlan
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(detail))
      return
    }
    // 도면 이미지 서빙 — JWT 인가 대상(가이드 8.3 blob-fetch)
    const img = req.url.split('?')[0].match(/^\/api\/maps\/([^/]+)\/image$/)
    if (img) {
      restCalls.push({ url: req.url, method: req.method, auth: !!req.headers.authorization })
      if (!activePlan || activePlan.id !== decodeURIComponent(img[1])) {
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: '이미지를 찾을 수 없습니다.' }))
        return
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'image/png' })
      res.end(activePlan.imageBytes)
      return
    }
    // 활성 맵 지정 — PUT /api/maps/{id}/active (실서버 계약)
    const act = req.url.match(/^\/api\/maps\/([^/]+)\/active$/)
    if (act) {
      restCalls.push({ url: req.url, method: req.method })
      if (!activateImplemented) {   // BE 미구현 상태 재현
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'No handler found' }))
        return
      }
      if (req.method !== 'PUT') {   // 실서버는 PUT 만 받는다
        res.writeHead(405, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'Method Not Allowed' }))
        return
      }
      activeId = act[1]
      // 활성 맵이 바뀌면 이전 세션 경로는 무효다 — 재하달 없이 autonomy 를 요청하면 거절된다
      activeMapSession++
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: activeId, active: true }))
      return
    }
    // 주행 속도 상한 (S15P11E101-515) — SettingsController 계약을 흉내낸다
    if (req.url.startsWith('/api/settings/drive-speed')) {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        let body = null
        try { body = b ? JSON.parse(b) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        const reply = (delivered) => {
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            robotId: 'orinka_01', maxLinear: drive.maxLinear, maxAngular: drive.maxAngular,
            delivered, updatedAt: '2026-07-31T00:00:00Z',
          }))
        }
        if (req.method === 'PUT') {
          // @Positive — 양수가 아니면 400
          if (!(Number(body?.maxLinear) > 0) || !(Number(body?.maxAngular) > 0)) {
            res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ message: '속도 상한은 양수여야 합니다.' }))
            return
          }
          drive.maxLinear = Number(body.maxLinear)
          drive.maxAngular = Number(body.maxAngular)
          return reply(robotOnline)   // 로봇에 SET_MAX_SPEED 중계 성공 여부
        }
        return reply(null)            // 조회 시 delivered 는 null
      })
      return
    }
    // 설비 임계 온도 (S15P11E101-525) — EquipmentController 계약을 흉내낸다
    if (req.url.startsWith('/api/equipments')) {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        let body = null
        try { body = b ? JSON.parse(b) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        const json = (code, payload) => {
          res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }
        const m = req.url.split('?')[0].match(/^\/api\/equipments\/(.+)$/)
        if (m && req.method === 'PUT') {
          const t = Number(body?.threshold)
          if (!Number.isFinite(t) || t <= 0) {          // @NotNull @Positive
            return json(400, { message: 'threshold 는 0보다 커야 합니다.' })
          }
          const e = equipments.find((x) => x.equipmentId === decodeURIComponent(m[1]))
          if (!e) return json(404, { message: '설비를 찾을 수 없습니다: ' + m[1] })
          e.threshold = t
          // 실서버는 갱신된 설비가 아니라 상태만 돌려준다
          return json(200, { status: 'success' })
        }
        if (req.method === 'GET') return json(200, equipments)
        return json(405, { message: 'method not allowed' })
      })
      return
    }
    // 순찰 경로 하달·시작 (S15P11E101-625) — PatrolRouteController 계약을 흉내낸다
    if (req.url.startsWith('/api/patrol-route')) {
      let pb = ''
      req.on('data', (c) => { pb += c })
      req.on('end', () => {
        let body = null
        try { body = pb ? JSON.parse(pb) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        const path = req.url.split('?')[0]
        const json = (code, payload) => {
          res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' })
          res.end(payload === undefined ? '' : JSON.stringify(payload))
        }
        if (path === '/api/patrol-route/apply' && req.method === 'POST') {
          // 경로를 다시 하달하면 로봇이 현재 활성 맵 세션으로 stamp 한다
          if (robotOnline) routeSession = activeMapSession
          return json(200, {
            status: 'SUCCESS', delivered: robotOnline, count: waypoints.length,
          })
        }
        if (path === '/api/patrol-route/start' && req.method === 'POST') {
          if (waypoints.length === 0) {
            // 빈 경로로는 로봇이 autonomy 를 거절하므로 SET_MODE 를 보내지 않는다
            return json(200, {
              status: 'NO_ROUTE', routeDelivered: robotOnline, patrolStarted: false, count: 0,
            })
          }
          if (robotOnline) { routeSession = activeMapSession; patrolRunning = true }
          return json(200, {
            status: 'SUCCESS', routeDelivered: robotOnline,
            patrolStarted: robotOnline, count: waypoints.length,
          })
        }
        const reorder = () => waypoints.forEach((w, i) => { w.seq = i + 1 })
        if (path === '/api/patrol-route' && req.method === 'GET') {
          return json(200, { robotId: 'orinka_01', count: waypoints.length, waypoints })
        }
        // 일괄 교체 — 본문은 { waypoints } 로 감싸여 온다(RouteRequest)
        if (path === '/api/patrol-route' && req.method === 'PUT') {
          const list = Array.isArray(body?.waypoints) ? body.waypoints : null
          if (!list) return json(400, { detail: 'waypoints 는 필수입니다.' })
          waypoints.length = 0
          list.forEach((w, i) => waypoints.push({
            id: `wp${++wpSeq}`, robotId: 'orinka_01', name: w.name ?? null,
            x: w.x, y: w.y, yaw: w.yaw ?? 0, seq: i + 1, createdAt: '2026-07-31T00:00:00Z',
          }))
          return json(200, { robotId: 'orinka_01', count: waypoints.length, waypoints })
        }
        if (path === '/api/patrol-route/points' && req.method === 'POST') {
          if (!Number.isFinite(Number(body?.x)) || !Number.isFinite(Number(body?.y))) {
            return json(400, { detail: 'waypoint x/y 는 유한한 숫자여야 합니다.' })
          }
          const w = {
            id: `wp${++wpSeq}`, robotId: 'orinka_01', name: body?.name ?? null,
            x: body.x, y: body.y, yaw: body?.yaw ?? 0,
            seq: waypoints.length + 1, createdAt: '2026-07-31T00:00:00Z',
          }
          waypoints.push(w)
          return json(201, w)
        }
        const pdel = path.match(/^\/api\/patrol-route\/points\/(.+)$/)
        if (pdel && req.method === 'DELETE') {
          const i = waypoints.findIndex((w) => w.id === decodeURIComponent(pdel[1]))
          if (i >= 0) waypoints.splice(i, 1)
          reorder()
          return json(204)
        }
        return json(405, { message: 'method not allowed' })
      })
      return
    }
    // 순찰 지점 (S15P11E101-514) — WaypointController 계약을 흉내낸다
    if (req.url.startsWith('/api/waypoints')) {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        let body = null
        try { body = b ? JSON.parse(b) : null } catch { body = null }
        restCalls.push({ url: req.url, method: req.method, body })
        const path = req.url.split('?')[0]
        const json = (code, payload) => {
          res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' })
          res.end(payload === undefined ? '' : JSON.stringify(payload))
        }
        const reorder = () => waypoints.forEach((w, i) => { w.seq = i + 1 })

        if (path === '/api/waypoints/apply' && req.method === 'POST') {
          return json(200, { status: robotOnline ? 'DELIVERED' : 'SAVED_ONLY', delivered: robotOnline, count: waypoints.length })
        }
        const del = path.match(/^\/api\/waypoints\/(.+)$/)
        if (del && req.method === 'DELETE') {
          const i = waypoints.findIndex((w) => w.id === decodeURIComponent(del[1]))
          if (i >= 0) waypoints.splice(i, 1)
          reorder()
          return json(204)
        }
        if (req.method === 'GET') return json(200, waypoints)
        if (req.method === 'POST') {
          const w = {
            id: `wp${++wpSeq}`, robotId: 'orinka_01', name: body?.name ?? null,
            x: body?.x, y: body?.y, yaw: body?.yaw ?? null,
            seq: waypoints.length + 1, createdAt: '2026-07-31T00:00:00Z',
          }
          waypoints.push(w)
          return json(201, w)
        }
        if (req.method === 'PUT') {
          waypoints.length = 0
          ;(Array.isArray(body) ? body : []).forEach((r, i) => waypoints.push({
            id: `wp${++wpSeq}`, robotId: 'orinka_01', name: r.name ?? null,
            x: r.x, y: r.y, yaw: r.yaw ?? null, seq: i + 1, createdAt: '2026-07-31T00:00:00Z',
          }))
          return json(200, waypoints)
        }
        return json(405, { message: 'method not allowed' })
      })
      return
    }
    // 로봇 목록 — 서버가 판정한 online 을 돌려준다 (S15P11E101-510)
    if (req.url.startsWith('/api/robots')) {
      restCalls.push({ url: req.url, method: req.method })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{
        robotId: 'orinka_01', name: '오린카-01',
        status: robotOnline ? 'AUTO_PATROL' : 'OFFLINE',
        battery: 82, speed: 0.3, estop: 'RELEASED', online: robotOnline,
      }]))
      return
    }
    if (req.url.startsWith('/api/maps')) {
      restCalls.push({ url: req.url, method: req.method })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.url.includes('/latest') ? (maps[0] || null) : maps))
      return
    }
    if (req.url.startsWith('/api/auth/')) {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        // 요청 본문을 기록해 둔다 — FE 가 실제로 무엇을 보내는지 검증용
        let parsed = null
        try { parsed = JSON.parse(b) } catch { parsed = b }
        restCalls.push({ url: req.url, body: parsed })
        // 권한 데모 — 이메일에 viewer 가 들어가면 뷰어로, 그 외에는 관리자로 응답한다.
        // 실서버는 계정마다 역할이 정해져 있지만, 화면 확인용으로 이렇게 나눈다(S15P11E101-475).
        // refresh — 유효한 refreshToken 이면 새 쌍을 내주고 옛 것을 폐기한다(회전)
        if (req.url.startsWith('/api/auth/refresh')) {
          refreshCalls++
          const rt = String(parsed?.refreshToken || '')
          if (!liveRefresh.has(rt)) {
            res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: 'refresh 토큰이 유효하지 않습니다.' }))
            return
          }
          liveRefresh.delete(rt)
          liveAccess.clear()                    // 이전 access 는 더 이상 쓰지 않는다
          // 실서버는 재발급 시 그 계정의 '현재' 권한으로 JWT 를 만든다 —
          // 승격·강등이 갱신 시점에 반영되는 것이 계약이다(S15P11E101-626).
          const owner = users.find((u) => u.email === lastEmail)
          if (owner) lastRole = owner.role
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify(issue(null, lastRole)))
          return
        }
        // 권한 데모 — 이메일에 viewer 가 들어가면 뷰어로, 그 외에는 관리자로 응답한다.
        const email = String(parsed?.email || '')
        // 비밀번호 검사. 원래는 아무 값이나 통과시켰는데, 그러면 '틀린 비밀번호' 경로를
        // 아예 확인할 수 없다(S15P11E101-653 잠금 해제). password 를 정답으로 두고
        // 그 외에는 401 을 준다 — 실서버 응답 형태와 같게.
        if (checkPassword && String(parsed?.password || '') !== PASSWORD) {
          res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: '이메일 또는 비밀번호가 올바르지 않습니다.' }))
          return
        }
        // 등록된 사용자면 그 역할을 그대로 준다(승격·강등이 다음 로그인에 반영된다).
        // 없는 이메일은 예전 규칙대로 — viewer 가 들어가면 뷰어, 아니면 관리자.
        lastEmail = email.toLowerCase()
        const known = users.find((x) => x.email.toLowerCase() === email.toLowerCase())
        lastRole = known ? known.role : (/viewer/i.test(email) ? 'ROLE_VIEWER' : 'ROLE_ADMIN')
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(issue(email, lastRole)))
      })
      return
    }
    res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
    res.end('{}')
  })

  server.on('upgrade', (req, socket) => {
    wsSockets.add(socket)
    socket.on('close', () => {
      wsSockets.delete(socket)
      // 브라우저 탭이 닫히면 그 세션이 들고 있던 조종 점유를 즉시 해제한다(실서버와 동일)
      const meta = socketMeta.get(socket)
      if (meta) { socketMeta.delete(socket); releaseAllForSession(meta.sessionId) }
    })
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    const head = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ]
    const proto = req.headers['sec-websocket-protocol']
    if (proto) head.push(`Sec-WebSocket-Protocol: ${proto.split(',')[0].trim()}`)
    socket.write(head.join('\r\n') + '\r\n\r\n')
    socket.setNoDelay(true)

    let buf = Buffer.alloc(0)
    let pending = ''
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const f = readFrame(buf)
        if (!f) break
        buf = f.rest
        if (f.opcode === 0x8) { socket.end(); return }
        if (f.opcode === 0x9) { sendFrame(socket, 0xA, f.payload); continue }
        if (f.opcode !== 0x1 && f.opcode !== 0x0) continue
        pending += f.payload.toString('utf8')
        let nul
        while ((nul = pending.indexOf('\0')) !== -1) {
          const raw = pending.slice(0, nul)
          pending = pending.slice(nul + 1)
          if (raw.trim()) onStomp(socket, raw)
        }
      }
    })
  })

  function onStomp(socket, raw) {
    const sep = raw.indexOf('\n\n')
    const headText = sep === -1 ? raw : raw.slice(0, sep)
    const body = sep === -1 ? '' : raw.slice(sep + 2)
    const lines = headText.split('\n').filter(Boolean)
    const command = lines[0].trim()
    const headers = {}
    lines.slice(1).forEach((l) => {
      const i = l.indexOf(':')
      if (i > 0) headers[l.slice(0, i)] = l.slice(i + 1)
    })

    if (command === 'CONNECT' || command === 'STOMP') {
      // 실서버는 CONNECT 에 Authorization: Bearer <JWT> 가 없거나 무효면 거부한다(S15P11E101-627).
      const auth = headers.Authorization || headers.authorization || ''
      lastConnect = { authorization: auth }
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (rejectStompAuth || !tok || (tokenSeq > 0 && !liveAccess.has(tok))) {
        sendText(socket, 'ERROR' + String.fromCharCode(10) + 'message:Unauthorized - invalid or missing JWT'
          + String.fromCharCode(10) + String.fromCharCode(10))
        socket.end()
        return
      }
      // 세션마다 고유 id — 조종 점유의 owner 가 이 값이다
      const sid = `sess-${++sessSeq}`
      socketMeta.set(socket, {
        sessionId: sid,
        email: tokenEmail.get(tok) || lastEmail || '',
        role: tokenRole.get(tok) || lastRole,
      })
      // heart-beat:0,0 → 하트비트 없이 유지 (계측 프레임만 남기려고)
      const nl = String.fromCharCode(10)
      sendText(socket, 'CONNECTED' + nl + 'version:1.2' + nl + 'heart-beat:0,0'
        + (sendSessionHeader ? nl + `session:${sid}` : '') + nl + nl)
      return
    }
    if (command === 'SUBSCRIBE') {
      subs.push({ id: headers.id, destination: headers.destination, socket })
      return
    }
    if (command === 'SEND') {
      const now = Date.now()
      if (t0 === null) t0 = now
      const dest = headers.destination || ''
      // 서버(RobotControlStompController)가 목적지별로 받는 command 를 그대로 흉내낸다.
      // 맞지 않으면 로그만 남기고 버린다(drop) — FE 가 잘못된 목적지로 보내면 조용히 사라진다.
      let body2 = null
      try { body2 = JSON.parse(body) } catch { body2 = null }
      const cmd = String(body2?.command || '').toUpperCase()
      const OPERATION = ['START_MAPPING', 'STOP_MAPPING', 'SAVE_MAP', 'NAVIGATE']
      const meta = socketMeta.get(socket) || {}
      const robotId = body2?.robot_id || body2?.robotId || ROBOT_DEFAULT

      // ---- 조종 점유 명령 (S15P11E101-779) ----
      // 로봇에 중계하지 않는다 — 점유 상태만 바꾸고 방송한다.
      if (dest === '/app/control/ownership') {
        // 로봇으로 중계되지는 않지만 '버려진 명령' 도 아니다 — 서버가 제 몫을 다한 프레임이다.
        // reason 을 비워 둬야 버려진 제어 명령을 세는 다른 검증(check-627 §7)이 오탐하지 않는다.
        sends.push({ t: now - t0, at: now, destination: dest, body, relayed: true, reason: '', payload: body2 })
        if (meta.role !== 'ROLE_ADMIN') { notifyDenied(meta.email, robotId, 'FORBIDDEN_ROLE'); return }
        if (cmd === 'RELEASE') { releaseOwnership(robotId, meta.sessionId); return }
        if (cmd === 'STATUS') { broadcastControl(robotId, 'STATUS'); return }
        const decision = claimOwnership(robotId, meta.sessionId, meta.email, cmd === 'TAKEOVER')
        if (decision === 'DENIED') notifyDenied(meta.email, robotId, 'OWNED_BY_OTHER')
        return
      }

      // ---- 제어 명령 관문: 권한 → 점유 ----
      // 실서버 RobotControlStompController.gate 와 같은 순서다. 통과 못 하면 로봇에 가지 않는다.
      if (dest.startsWith('/app/control/')) {
        if (meta.role !== 'ROLE_ADMIN') {
          notifyDenied(meta.email, robotId, 'FORBIDDEN_ROLE')
          sends.push({ t: now - t0, at: now, destination: dest, body, relayed: false, reason: 'FORBIDDEN_ROLE', payload: null })
          return
        }
        // 암묵 획득 — 비어 있으면 첫 명령자가 소유자가 된다(하위호환 경로)
        if (claimOwnership(robotId, meta.sessionId, meta.email, false) === 'DENIED') {
          notifyDenied(meta.email, robotId, 'OWNED_BY_OTHER')
          sends.push({ t: now - t0, at: now, destination: dest, body, relayed: false, reason: 'OWNED_BY_OTHER', payload: null })
          return
        }
      }

      let relayed = true
      let reason = ''
      if (dest === '/app/control/operation' && !OPERATION.includes(cmd)) {
        relayed = false; reason = `알 수 없는 operation command: ${cmd}`
      } else if (dest === '/app/control/mode' && cmd === 'ESTOP' && body2?.active !== true) {
        relayed = false; reason = 'ESTOP active 는 true 만 허용됩니다.'
      } else if (dest === '/app/control/camera' && body2?.tilt == null) {
        relayed = false; reason = 'CAMERA_TILT 는 tilt 가 필요합니다.'
      }
      // 카메라 각도는 서버가 가동범위로 클램프해 중계한다
      if (relayed && dest === '/app/control/camera') {
        body2.tilt = Math.max(cameraTiltMin, Math.min(cameraTiltMax, Number(body2.tilt)))
        body2.command = 'CAMERA_TILT'
      }
      sends.push({
        t: now - t0, at: now, destination: dest, body,
        relayed, reason,
        // 중계된 payload — 클램프 결과를 확인하려면 이쪽을 본다
        payload: relayed ? body2 : null,
      })
      return
    }
    if (command === 'DISCONNECT') {
      if (headers.receipt) sendText(socket, `RECEIPT\nreceipt-id:${headers.receipt}\n\n`)
      socket.end()
    }
  }

  return new Promise((resolve) => {
    // close() 가 열린 소켓을 기다리며 멈추지 않도록 추적해 두고 강제로 끊는다
    const sockets = new Set()
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

    server.listen(port, '127.0.0.1', () => resolve({
      sends,
      subs,
      restCalls,
      push,
      maps,
      // 로봇이 SAVE_MAP 을 처리해 업로드한 상황을 만든다 (최신이 맨 앞)
      addMap: (name) => { maps.unshift({ id: `m${maps.length + 1}`, name, widthPx: 480, heightPx: 320, resolution: 0.05 }); return maps[0] },
      setActivateImplemented: (v) => { activateImplemented = v },
      // 744 검증용 — REST 복원값과 STOMP 전환을 함께 움직인다
      setGridImplemented: (v) => { gridImplemented = v },
      setStatsOverheat: (v) => { statsOverheat = v },
      setStatsWeekly: (v) => { statsWeekly = v },
      setStatsBattery: (v) => { statsBattery = v },
      zones: () => zones,
      setZones: (v) => { zones = v },
      mappingPhase: () => mappingPhase,
      setMappingPhase: (phase, { push: doPush = true } = {}) => {
        mappingPhase = phase
        if (doPush) push('/topic/mapping', { type: 'MAPPING_STATUS', phase, robotId: 'orinka_01', mapping: phase === 'MAPPING' })
      },
      pushFloorplanReady: (mapId = 'fp1') => {
        mappingPhase = 'IDLE'
        return push('/topic/mapping', { type: 'FLOORPLAN_READY', robotId: 'orinka_01', mapId, imageUrl: `/api/maps/${mapId}/image` })
      },
      activeId: () => activeId,
      setExpiresIn: (v) => { expiresIn = v },
      setRejectAuth: (v) => { rejectAuth = v },
      // 613 검증용 — access 를 즉시 만료시키거나, 구버전 서버(refresh 없음)를 흉내낸다
      setLegacyAuth: (v) => { legacyAuth = v },
      expireAccess: () => { liveAccess.clear() },
      revokeRefresh: () => { liveRefresh.clear() },
      refreshCount: () => refreshCalls,
      setWithEquipment: (v) => { withEquipment = v },
      setCheckPassword: (v) => { checkPassword = v },
      clips: CLIPS,
      connectHeaders: () => lastConnect,
      rejectStomp: (v) => { rejectStompAuth = v },
      // 열린 STOMP 소켓을 끊어 클라이언트의 자동 재연결을 유도한다(627 검증)
      dropStompSockets: () => { subs.splice(0, subs.length); wsSockets.forEach((so) => { try { so.end() } catch { /* 이미 닫힘 */ } }); wsSockets.clear() },
      // 625 검증용 — 로봇이 STOMP SET_MODE autonomy 를 받아들일 상태인지
      routeSessionValid: () => routeSession === activeMapSession,
      patrolRunning: () => patrolRunning,
      activeMapSession: () => activeMapSession,
      users,
      // 이미 발급된 access 의 역할만 낮춘다 — 화면은 관리자로 알고 있는데 서버가 거절하는 상황
      demoteTokens: () => { for (const k of tokenRole.keys()) tokenRole.set(k, 'ROLE_USER') },
      setFailNext: (n) => { failNext = n },
      setRobotOnline: (v) => { robotOnline = v },
      equipments,
      setActivePlan: (p) => { activePlan = p },
      activePlan: () => activePlan,
      waypoints,
      drive,
      events: EVENTS,
      // 조종 점유 — 검증 스크립트가 서버 쪽 진실을 직접 확인할 수 있게 열어 둔다
      ownership: () => liveLease(ROBOT_DEFAULT),
      ownershipSessions: () => [...socketMeta.values()],
      close: () => new Promise((r) => {
        clearInterval(sweep)
        sockets.forEach((s) => s.destroy())
        sockets.clear()
        server.close(r)
      }),
    }))
  })
}

// ---- WebSocket 프레이밍 (최소 구현) ----
function readFrame(b) {
  if (b.length < 2) return null
  const opcode = b[0] & 0x0f
  const masked = (b[1] & 0x80) !== 0
  let len = b[1] & 0x7f
  let off = 2
  if (len === 126) { if (b.length < off + 2) return null; len = b.readUInt16BE(off); off += 2 }
  else if (len === 127) { if (b.length < off + 8) return null; len = Number(b.readBigUInt64BE(off)); off += 8 }
  let mask = null
  if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4 }
  if (b.length < off + len) return null
  const payload = Buffer.from(b.subarray(off, off + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { opcode, payload, rest: b.subarray(off + len) }
}

function sendFrame(socket, opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = len }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  header[0] = 0x80 | opcode
  socket.write(Buffer.concat([header, payload]))
}
const sendText = (socket, s) => sendFrame(socket, 0x1, Buffer.from(s + '\0', 'utf8'))
