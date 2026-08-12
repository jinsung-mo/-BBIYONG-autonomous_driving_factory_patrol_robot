#!/usr/bin/env node
/**
 * 가짜 관제 WS 하네스 — 로봇 없이 FE 를 개발·검증한다.
 *
 * 왜 필요한가
 *   Orin 은 한 대뿐이고, FE 를 확인하려고 로봇 스택을 만지면 매핑이 죽는다(2026-08-12 실제
 *   사고: systemctl start 한 번이 진행 중인 매핑을 날렸다). 그래서 관제 쪽은 로봇에 접속하지
 *   않고 이 하네스로 개발한다.
 *
 * 무엇을 흉내내나
 *   BE → FE 방향만. 즉 STOMP over WebSocket 서버로서 아래 목적지에 MESSAGE 를 밀어 넣는다.
 *     /topic/video/{robotId}   VIDEO_FRAME  (실제 720p JPEG 을 base64 로)
 *     /topic/robots            TELEMETRY    (2Hz, status 를 사이클로 돌린다)
 *     /topic/alerts            EVENT_FIRE · EVENT_SYSTEM
 *   로봇 → BE 방향은 흉내내지 않는다. FE 가 소비하는 것은 **BE 가 재직렬화한 RobotPacket**
 *   이므로, 그 모양만 맞으면 된다.
 *
 * 왜 의존성이 없나
 *   `ws` 를 devDependency 로 넣으면 package-lock.json 이 크게 흔들린다. 개발 도구 하나 때문에
 *   설치 트리를 건드리는 대신 RFC 6455 서버 측을 직접 구현했다 — 우리가 받는 프레임은
 *   stompjs 의 작은 텍스트 프레임뿐이라 분할(fragmentation)을 만나지 않는다. 보내는 쪽은
 *   우리가 만들므로 분할하지 않는다.
 *
 * 쓰는 법
 *   node tools/fake-ws-harness.mjs                 # 기본 8099 포트, 5fps
 *   node tools/fake-ws-harness.mjs --fps 15 --port 9000
 *
 *   그리고 FE 를 이 하네스로 향하게 띄운다:
 *     VITE_WS_URL=ws://localhost:8099/ws/control npm run dev
 *
 *   🔴 REST(로그인·이벤트 목록)는 흉내내지 않는다. 로그인 화면을 지나야 하는 화면을 보려면
 *      REST 는 실서버를 쓰거나 별도 목을 세워야 한다. 이 하네스의 목적은 **실시간 스트림**이다.
 *
 * 인자
 *   --port N            (8099)   수신 포트
 *   --robot-id S        (orinka_01)
 *   --fps N             (5)      VIDEO_FRAME 송신률. 로봇의 현재 상한과 같은 값이 기본
 *   --frame PATH        (samples/frame_720p.jpg)  실제 로봇 프레임
 *   --stage-seconds N   (15)     status 를 다음 단계로 넘기는 간격
 *   --no-stage-cycle             status 를 AUTO_PATROL 로 고정
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// STOMP 프레임은 NUL 로 끝난다. 소스에 제어문자를 직접 넣으면 git 이 이 파일을 바이너리로
// 취급해 diff·리뷰가 불가능해지므로(실제로 한 번 그렇게 됐다) 코드로 만든다.
const NUL = String.fromCharCode(0)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ── 인자 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const PORT = Number(opt('port', 8099))
const ROBOT_ID = opt('robot-id', 'orinka_01')
const FPS = Number(opt('fps', 5))
const FRAME_PATH = opt('frame', join(HERE, 'samples', 'frame_720p.jpg'))
const STAGE_SECONDS = Number(opt('stage-seconds', 15))
const STAGE_CYCLE = !flag('no-stage-cycle')

// ── 픽스처 ──────────────────────────────────────────────────────────────────
// 실제 로봇에서 뜬 것이다. 합성 데이터로 바꾸지 말 것 — 크기와 dets 모양이 실제여야
// 처리량·좌표 문제가 여기서 재현된다.
const frameBytes = readFileSync(FRAME_PATH)
const frameB64 = frameBytes.toString('base64')
const cam = JSON.parse(readFileSync(join(HERE, 'samples', 'cam.json'), 'utf8'))

// ── WebSocket 최소 구현 ─────────────────────────────────────────────────────
/** 서버 → 클라이언트 텍스트 프레임. 마스킹하지 않는다(서버는 마스킹 금지). */
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    // 영상 프레임(base64 ~137KB)이 여기로 온다.
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * 클라이언트 → 서버 프레임을 뽑아낸다. 클라이언트 프레임은 **항상 마스킹**돼 있다.
 * 완성되지 않은 프레임은 rest 로 남겨 다음 데이터와 합친다.
 */
function decodeFrames(buf) {
  const texts = []
  let closed = false
  let off = 0
  while (buf.length - off >= 2) {
    const b0 = buf[off]
    const b1 = buf[off + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (buf.length - p < 2) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (buf.length - p < 8) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    let mask = null
    if (masked) {
      if (buf.length - p < 4) break
      mask = buf.subarray(p, p + 4)
      p += 4
    }
    if (buf.length - p < len) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
    off = p + len
    if (opcode === 0x1) texts.push(payload.toString('utf8'))
    else if (opcode === 0x8) closed = true
    // ping/pong·binary 는 이 하네스에서 쓰지 않는다
  }
  return { texts, closed, rest: buf.subarray(off) }
}

// ── STOMP 최소 구현 ─────────────────────────────────────────────────────────
function stompFrame(command, headers, body = '') {
  const lines = [command]
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}:${v}`)
  return `${lines.join('\n')}\n\n${body}${NUL}`
}

function parseStomp(text) {
  const nul = text.indexOf(NUL)
  const raw = nul >= 0 ? text.slice(0, nul) : text
  if (!raw.trim()) return null // 하트비트(개행만)
  const sep = raw.indexOf('\n\n')
  const head = sep >= 0 ? raw.slice(0, sep) : raw
  const body = sep >= 0 ? raw.slice(sep + 2) : ''
  const [command, ...hlines] = head.split('\n')
  const headers = {}
  for (const line of hlines) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1)
  }
  return { command, headers, body }
}

// ── 시나리오 ────────────────────────────────────────────────────────────────
// 로봇이 **지금은 안 보내는** 단계까지 넣는다. 단계 표시 UI 를 로봇보다 먼저 만들 수 있고,
// 모르는 값을 UI 가 어떻게 처리하는지도 여기서 확인된다.
const STAGES = [
  'BOOT', 'READY', 'MAPPING', 'SAVING', 'LOCALIZING',
  'AUTO_PATROL', 'APPROACH', 'VERIFY', 'AUTO_PATROL', 'DEGRADED',
]

let msgId = 0
let videoSeq = 0
let stageIdx = 0
let battery = 87.9

const clients = new Set()

/** 구독 중인 클라이언트 전원에게 목적지 기준으로 보낸다. */
function publish(destination, payload) {
  const body = JSON.stringify(payload)
  for (const c of clients) {
    for (const [subId, dest] of c.subs) {
      if (dest !== destination) continue
      c.send(stompFrame('MESSAGE', {
        destination,
        subscription: subId,
        'message-id': String(++msgId),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      }, body))
    }
  }
}

function buildVideoFrame() {
  return {
    source: 'robot',
    type: 'VIDEO_FRAME',
    robot_id: ROBOT_ID,
    channel: 'FRONT',
    format: 'jpeg',
    data: frameB64,
    seq: ++videoSeq,
    // 로봇이 2026-08-12 에 추가한 촬영 시각. 🔴 서버 RobotPacket 에 필드가 선언되지 않으면
    // 실서버에서는 이 값이 사라진다 — 하네스에서는 보이지만 실제로는 안 보일 수 있다.
    captureTs: Math.round(Date.now() / 1000 * 1000) / 1000,
    maxTemp: null,
  }
}

function buildTelemetry() {
  battery = Math.max(5, battery - 0.01)
  const t = Date.now() / 1000
  return {
    source: 'robot',
    type: 'TELEMETRY',
    robot_id: ROBOT_ID,
    status: STAGE_CYCLE ? STAGES[stageIdx] : 'AUTO_PATROL',
    battery: Math.round(battery * 10) / 10,
    location: {
      x: 5 + 2 * Math.sin(t / 8),
      y: 3 + 2 * Math.cos(t / 8),
      yaw: (t / 4) % (Math.PI * 2),
    },
    timestamp: Math.floor(t),
    estop: 'RELEASED',
    commLatencyMs: 40 + Math.floor(Math.random() * 30),
    // 🔴 실제 로봇이 보내는 값을 그대로 쓴다. 이건 "추론 1회 소요시간의 역수"라서
    //    실제 추론율(DET_HZ=4Hz)과 23배 다르다. 하네스가 이 거짓을 재현하는 것이 맞다 —
    //    UI 가 92.7 을 어떻게 보여주는지 봐야 계약을 고칠 근거가 된다.
    inferenceFps: cam.det_fps,
    orinPower: { cpuCores: [24.3, 16.2, 14.6, 7.2, 5.5, 4.0], gpuPercent: 12, vddInMw: 9800 },
    readiness: { canStartPatrol: true, canStartMapping: true, blockedBy: null, hint: null },
    charging: false,
    minutesToFull: null,
  }
}

// ── 서버 ────────────────────────────────────────────────────────────────────
const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`fake-ws-harness\nSTOMP: ws://localhost:${PORT}/ws/control\nclients=${clients.size}\n`)
})

http.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ]
  // stompjs 가 서브프로토콜을 요구하면 하나를 골라 돌려준다 — 안 돌려주면 붙지 않는 구현이 있다.
  const offered = (req.headers['sec-websocket-protocol'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (offered.length) lines.push(`Sec-WebSocket-Protocol: ${offered.includes('v12.stomp') ? 'v12.stomp' : offered[0]}`)
  socket.write(lines.join('\r\n') + '\r\n\r\n')

  const client = {
    subs: new Map(),
    send: (text) => { if (!socket.destroyed) socket.write(encodeTextFrame(text)) },
  }
  clients.add(client)
  socket.setNoDelay(true)
  let buf = Buffer.alloc(0)

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    const { texts, closed, rest } = decodeFrames(buf)
    buf = rest
    for (const text of texts) {
      const f = parseStomp(text)
      if (!f) continue
      if (f.command === 'CONNECT' || f.command === 'STOMP') {
        // Authorization 헤더는 **검사하지 않는다.** 이 하네스는 자격증명을 다루지 않는다.
        // heart-beat:0,0 으로 하트비트를 사절해 구현을 단순하게 유지한다.
        client.send(stompFrame('CONNECTED', { version: '1.2', 'heart-beat': '0,0' }))
        log(`CONNECT 수락 (auth 무시) — 구독 대기`)
      } else if (f.command === 'SUBSCRIBE') {
        client.subs.set(f.headers.id, f.headers.destination)
        log(`SUBSCRIBE ${f.headers.destination}`)
      } else if (f.command === 'UNSUBSCRIBE') {
        client.subs.delete(f.headers.id)
      } else if (f.command === 'DISCONNECT') {
        socket.end()
      }
      // SEND(/app/...) 는 이 하네스가 처리할 대상이 없어 무시한다
    }
    if (closed) socket.end()
  })

  const drop = () => { clients.delete(client); log(`연결 종료 (남은 클라이언트 ${clients.size})`) }
  socket.on('close', drop)
  socket.on('error', drop)
})

const log = (m) => console.log(`[harness ${new Date().toTimeString().slice(0, 8)}] ${m}`)

// ── 송신 루프 ───────────────────────────────────────────────────────────────
setInterval(() => publish(`/topic/video/${ROBOT_ID}`, buildVideoFrame()), Math.max(1000 / FPS, 1))
setInterval(() => publish('/topic/robots', buildTelemetry()), 500)

if (STAGE_CYCLE) {
  setInterval(() => {
    stageIdx = (stageIdx + 1) % STAGES.length
    log(`단계 → ${STAGES[stageIdx]}`)
    if (STAGES[stageIdx] === 'DEGRADED') {
      publish('/topic/alerts', {
        source: 'robot', type: 'EVENT_SYSTEM', robot_id: ROBOT_ID,
        code: 'PLANNER_DOWN', message: '경로 계획기가 응답하지 않습니다. 순찰을 멈췄습니다.',
        timestamp: Math.floor(Date.now() / 1000),
      })
    }
    if (STAGES[stageIdx] === 'VERIFY') {
      publish('/topic/alerts', {
        source: 'robot', type: 'EVENT_FIRE', robot_id: ROBOT_ID,
        confidence: 0.94, temperature: 58.4,
        location: { x: 15.0, y: 8.2 }, timestamp: Math.floor(Date.now() / 1000),
      })
    }
  }, STAGE_SECONDS * 1000)
}

// 30초마다 실제로 얼마를 밀어냈는지 남긴다 — 로봇의 [video:mjpeg] 로그와 같은 목적이다.
let sentAtLastLog = 0
setInterval(() => {
  const n = videoSeq - sentAtLastLog
  sentAtLastLog = videoSeq
  const mb = (n * Buffer.byteLength(frameB64) * 1.0) / 1024 / 1024
  log(`최근 30초 ${n}프레임 × 구독자 (${(n / 30).toFixed(1)} fps) · 프레임당 ${(frameB64.length / 1024).toFixed(0)}KB(base64) · 약 ${(mb / 30 * 8).toFixed(1)} Mbps/구독자`)
}, 30000)

http.listen(PORT, () => {
  log(`듣는 중 — STOMP ws://localhost:${PORT}/ws/control`)
  log(`프레임 ${FRAME_PATH} (${(frameBytes.length / 1024).toFixed(0)}KB raw → ${(frameB64.length / 1024).toFixed(0)}KB base64) · ${FPS}fps`)
  log(`FE 를 이렇게 띄운다: VITE_WS_URL=ws://localhost:${PORT}/ws/control npm run dev`)
})
