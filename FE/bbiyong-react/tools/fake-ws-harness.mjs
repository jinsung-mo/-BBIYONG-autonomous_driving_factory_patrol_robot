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
 *     /topic/video/{robotId}   VIDEO_FRAME  channel:"THERMAL" (32x24 PNG)
 *     /topic/robots            TELEMETRY    (2Hz, status 를 사이클로 돌린다)
 *     /topic/alerts            EVENT_FIRE · EVENT_SYSTEM
 *   로봇 → BE 방향은 흉내내지 않는다. FE 가 소비하는 것은 **BE 가 재직렬화한 RobotPacket**
 *   이므로, 그 모양만 맞으면 된다.
 *
 * 🔴 [2026-08-12 계약 변경] FRONT 카메라는 WS 로 오지 않는다
 *   로봇이 `ORINCAR_VIDEO_TRANSPORT=off` 로 전환했고 FRONT 는 HLS(nginx 정적)로 나간다
 *   (적용 확인: `[bridge] transport=off`, Orin TX 12.3 → 8.2 Mbps).
 *   그래서 **WS 로 오는 영상은 열화상 하나뿐**이다. FRONT 발행은 `--legacy-front` 뒤로
 *   물려 뒀다 — 옛 동작을 재현해야 할 때만 쓴다. 기본으로 켜 두면 하네스가 계약과 다른
 *   것을 가르치게 된다.
 *
 * 열화상에서 놓치기 쉬운 것 (레인 A 가 실물 샘플과 함께 알려준 것)
 *   · `pixels` 는 온도가 아니라 **온도 × 10 의 int** 다
 *   · 센서가 뒤집혀 달려 있어 로봇이 **180° 회전(_rotate_cw180)해서 보낸다**
 *   · `ir.json` 에 **시각 필드가 없다** — `build_thermal` 은 신선도를 판정하지 않는다.
 *     그래서 FE 는 **도착 간격으로만** 신선도를 알 수 있다. 로봇이 멈추면 화면은 조용히
 *     옛 프레임을 유지한다 → `--stall-seconds` 로 그 상황을 만들어 시험할 수 있다.
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
 *   --thermal PATH      (samples/thermal_sample.json)  열화상 실물 샘플
 *   --thermal-hz N      (1)      열화상 송신률
 *   --stall-seconds N   (0)      N초마다 열화상을 끊었다 재개한다(0=안 끊음). stale 판정 시험
 *   --stage-seconds N   (15)     status 를 다음 단계로 넘기는 간격
 *   --det-hz N          (4)      검출 박스 송신률(0=끔)
 *   --no-stage-cycle             status 를 AUTO_PATROL 로 고정
 *   --legacy-front               🔴 FRONT 를 WS 로 보낸다(계약과 다름, 옛 동작 재현용)
 *   --fps N             (5)      --legacy-front 일 때의 FRONT 송신률
 *   --frame PATH        (samples/frame_720p.jpg)  --legacy-front 일 때의 FRONT 프레임
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
const THERMAL_PATH = opt('thermal', join(HERE, 'samples', 'thermal_sample.json'))
const THERMAL_HZ = Number(opt('thermal-hz', 1))
const STAGE_SECONDS = Number(opt('stage-seconds', 15))
const STAGE_CYCLE = !flag('no-stage-cycle')
const LEGACY_FRONT = flag('legacy-front')
// 열화상을 주기적으로 끊는다 — ir.json 에 시각 필드가 없어 FE 는 도착 간격으로만 신선도를
// 판정할 수 있다. 그 판정 로직을 시험할 수단이 없으면 "조용히 옛 프레임 유지"를 못 잡는다.
const STALL_SECONDS = Number(opt('stall-seconds', 0))

// ── 픽스처 ──────────────────────────────────────────────────────────────────
// 실제 로봇에서 뜬 것이다. 합성 데이터로 바꾸지 말 것 — 크기와 dets 모양이 실제여야
// 처리량·좌표 문제가 여기서 재현된다.
const cam = JSON.parse(readFileSync(join(HERE, 'samples', 'cam.json'), 'utf8'))

// FRONT 픽스처는 --legacy-front 일 때만 읽는다. 계약상 더 이상 오지 않는 경로이므로
// 기본 실행에서 이 파일에 의존하지 않는다.
let frameB64 = null
let frameBytes = null
if (LEGACY_FRONT) {
  frameBytes = readFileSync(FRAME_PATH)
  frameB64 = frameBytes.toString('base64')
}

/**
 * 열화상 실물 샘플. 레인 A 가 라이브 `cloud_bridge.build_thermal()` 을 그대로 호출해 뽑은
 * 것이라 필드가 손대지지 않았다 — **합성으로 대체하지 말 것.** 합성으로는 온도 스케일
 * (×10 int)·180° 회전·시각 필드 부재를 재현할 수 없다.
 *
 * 실제 샘플의 구조는 이렇다 — 각 프레임이 **메타로 한 겹 감싸여 있다**:
 *   { contract:{…}, fields:[…], frames:[ { _capturedAtEpoch, _note, payload:{…} }, … ] }
 * 그래서 `payload` 를 벗겨내야 한다. 초안 로더는 `data` 를 최상위에서 찾다가 실물을 못 읽었다.
 *
 * 최상위·프레임 양쪽을 몇 가지 모양으로 받아 준다(샘플 형식이 또 바뀌어도 조용히 죽지 않게):
 *   최상위: [ … ] · { frames:[ … ] } · { …단일… }
 *   프레임: { payload:{ …data… } } · { …data… }
 */
function loadThermalFrames(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { frames: [], error: err.code === 'ENOENT' ? '파일 없음' : String(err.message) }
  }
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.frames) ? raw.frames
      : (raw && typeof raw === 'object') ? [raw]
        : []
  // 메타 껍데기를 벗긴다. 촬영 시각(_capturedAtEpoch)은 실제 간격을 보여주는 데만 쓴다.
  const usable = []
  const capturedAt = []
  for (const item of list) {
    const p = (item && typeof item.payload === 'object') ? item.payload : item
    if (typeof p?.data === 'string' && p.data.length > 0) {
      usable.push(p)
      if (typeof item?._capturedAtEpoch === 'number') capturedAt.push(item._capturedAtEpoch)
    }
  }
  if (!usable.length) {
    return { frames: [], error: 'data 필드를 가진 프레임을 못 찾았다(payload 로 감싸인 구조인지 확인)' }
  }
  return { frames: usable, error: null, contract: raw?.contract, capturedAt }
}

const thermal = loadThermalFrames(THERMAL_PATH)

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

let thermalIdx = 0
let thermalSeq = 0
let thermalMuted = false

/**
 * 열화상 프레임. 실물 샘플의 필드를 **그대로** 내보낸다 — 특히 `maxTemp` 는 캔버스 HUD 의
 * `MAX xx.x°C` 에 직접 쓰이므로 하네스가 값을 만들어내면 안 된다.
 *
 * `seq` 만 덮어쓴다: 샘플 3장을 돌려 쓰면 seq 가 되돌아가는데 실제 로봇의 seq 는 단조
 * 증가한다. 되돌아가는 seq 는 별도로 시험할 일이고 기본 동작에서 재현하면 안 된다.
 */
function buildThermalFrame() {
  const src = thermal.frames[thermalIdx++ % thermal.frames.length]
  return { ...src, robot_id: ROBOT_ID, seq: ++thermalSeq }
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
// 🔴 FRONT 는 기본으로 보내지 않는다 — 계약상 WS 로 오지 않는다(HLS 로 이동).
if (LEGACY_FRONT) {
  log('⚠ --legacy-front: FRONT 를 WS 로 보낸다. 2026-08-12 계약과 다르다 — 옛 동작 재현용이다')
  setInterval(() => publish(`/topic/video/${ROBOT_ID}`, buildVideoFrame()), Math.max(1000 / FPS, 1))
}

if (thermal.frames.length) {
  setInterval(() => {
    if (thermalMuted) return
    publish(`/topic/video/${ROBOT_ID}`, buildThermalFrame())
  }, Math.max(1000 / THERMAL_HZ, 1))
  if (STALL_SECONDS > 0) {
    setInterval(() => {
      thermalMuted = !thermalMuted
      log(thermalMuted
        ? `열화상 송신 중단 ${STALL_SECONDS}초 — FE 의 stale 판정을 시험한다(화면이 조용히 옛 프레임을 유지하는지)`
        : '열화상 송신 재개')
    }, STALL_SECONDS * 1000)
  }
} else {
  // 🔴 합성 데이터로 대체하지 않는다. 온도 스케일(×10 int)·180° 회전·시각 필드 부재를
  //    합성으로는 재현할 수 없고, 틀린 것을 가르치는 하네스는 없는 것보다 나쁘다.
  log(`🔴 열화상 샘플을 못 읽었다 (${THERMAL_PATH}) — ${thermal.error}`)
  log('   열화상 발행을 건너뛴다. 지금 WS 로 오는 유일한 영상 경로가 이것이므로 샘플이 필요하다.')
  log('   레인 A 에 요청: 라이브 cloud_bridge.build_thermal() 결과 3프레임을 JSON 으로.')
}

// ── 검출 박스 (DETECTIONS) ─────────────────────────────────────────────────
//
// 🔴 [2026-08-12] FRONT 가 HLS 로 가면서 프레임에 박스를 실을 수 없게 됐다.
//    종전에는 로봇이 JPEG 픽셀에 cv2.rectangle 로 그려 보냈다. 이제 별도 메시지다.
//
// 🔴 함정을 **일부러 재현한다**: src_w/src_h 를 실물 cam.json 값(640x360)으로 둔다.
//    영상은 1280x720 이므로 FE 가 고정 상수로 나누면 정확히 2배 어긋난다. 하네스가
//    실물과 같은 함정을 갖고 있어야 "우리 화면에서는 맞는데 실기에서 틀린" 일이 없다.
//
// 🔴 captureTs 는 **지금 시각**이다. FE 는 이것을 HLS 지연(약 6초)만큼 늦춰서 꺼내야
//    한다. 그냥 그리면 불이 화면에 나타나기 전에 박스가 먼저 뜬다.
//
// dets 는 합성이다 — 실물 cam.json 의 dets 가 비어 있어(촬영 당시 불이 없었다) 그대로
// 쓰면 오버레이가 한 번도 안 그려진다. 기준 해상도만 실물을 따르고 상자는 움직이게 만든다.
const DET_HZ = Number(opt('det-hz', 4))
const DET_SRC_W = Number(cam.src_w ?? 640)
const DET_SRC_H = Number(cam.src_h ?? 360)
let detSeq = 0

function buildDetections() {
  detSeq += 1
  const t = Date.now() / 1000
  const phase = (t % 8) / 8
  // 8초 중 2초는 빈 목록 — "불이 꺼지면 박스가 지워지는가"를 시험한다.
  const dets = phase > 0.75 ? [] : [(() => {
    const cx = DET_SRC_W * (0.5 + 0.25 * Math.cos(phase * 2 * Math.PI))
    const cy = DET_SRC_H * (0.5 + 0.25 * Math.sin(phase * 2 * Math.PI))
    const w = DET_SRC_W * 0.18
    const h = DET_SRC_H * 0.22
    return {
      cls: phase < 0.4 ? 1 : 0,
      name: phase < 0.4 ? 'fire' : 'smoke',
      conf: 0.62 + 0.3 * Math.abs(Math.sin(phase * Math.PI)),
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2].map((v) => Math.round(v * 10) / 10),
    }
  })()]
  return {
    source: 'robot',
    type: 'DETECTIONS',
    robot_id: ROBOT_ID,
    captureTs: t,
    src_w: DET_SRC_W,
    src_h: DET_SRC_H,
    dets,
    seq: detSeq,
  }
}

if (DET_HZ > 0) {
  setInterval(() => publish(`/topic/video/${ROBOT_ID}`, buildDetections()),
    Math.max(1000 / DET_HZ, 1))
  log(`DETECTIONS ${DET_HZ}Hz · 기준 ${DET_SRC_W}x${DET_SRC_H} (영상 1280x720 과 2배 차이 — 정규화 확인용)`)
  log('  captureTs 는 지금 시각이다 — FE 가 HLS 지연만큼 늦춰 꺼내는지 확인하라')
}

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
let frontAtLastLog = 0
let thermalAtLastLog = 0
setInterval(() => {
  const parts = []
  if (LEGACY_FRONT) {
    const n = videoSeq - frontAtLastLog
    frontAtLastLog = videoSeq
    const kb = frameB64 ? frameB64.length / 1024 : 0
    parts.push(`FRONT ${n}장 (${(n / 30).toFixed(1)} fps · 장당 ${kb.toFixed(0)}KB · 약 ${(n * kb * 8 / 30 / 1024).toFixed(1)} Mbps/구독자)`)
  }
  if (thermal.frames.length) {
    const n = thermalSeq - thermalAtLastLog
    thermalAtLastLog = thermalSeq
    parts.push(`THERMAL ${n}장 (${(n / 30).toFixed(1)} fps)${thermalMuted ? ' · 지금 중단 중' : ''}`)
  }
  if (parts.length) log(`최근 30초 — ${parts.join(' · ')}`)
}, 30000)

http.listen(PORT, () => {
  log(`듣는 중 — STOMP ws://localhost:${PORT}/ws/control`)
  if (thermal.frames.length) {
    const f0 = thermal.frames[0]
    const temps = thermal.frames.map((f) => f.maxTemp).join(', ')
    log(`열화상 ${thermal.frames.length}장 · format=${f0.format} · data ${f0.data.length}자 · ${THERMAL_HZ}Hz`)
    log(`  maxTemp: ${temps} — 캔버스 HUD 'MAX xx.x°C' 에 그대로 쓰인다`)
    // 실제 촬영 간격을 보여 준다. 균일하지 않다(실측 1.52s · 0.50s) — FE 가 균일 도착을
    // 가정하면 안 된다는 증거다. 하네스는 기본으로 --thermal-hz 로 균일하게 보낸다.
    if (thermal.capturedAt?.length > 1) {
      const gaps = thermal.capturedAt.slice(1).map((t, i) => (t - thermal.capturedAt[i]).toFixed(2))
      log(`  실제 촬영 간격: ${gaps.join('s, ')}s (균일하지 않다)`)
    }
    // 🔴 이 샘플은 회전 정리 **전에** 뜬 것이다 — 로봇의 _rotate_cw180 이 아직 들어 있다.
    //    FE 의 THERMAL_ROT_DEG=90 과 합쳐 화면에서는 270° 가 된다. 레인 A 가 로봇 쪽 회전을
    //    0 으로 내리면(합의 2026-08-12) 그때부터 FE 90° 만 남는다. 방향이 이상해 보이면
    //    하네스가 아니라 이 시차 때문이다.
    log('  ⚠ 이 샘플은 로봇 회전 정리 전(_rotate_cw180 포함) — FE 90° 와 합쳐 270° 로 보인다')
  }
  if (LEGACY_FRONT) {
    log(`FRONT(옛 경로) ${FRAME_PATH} — ${(frameBytes.length / 1024).toFixed(0)}KB raw → ${(frameB64.length / 1024).toFixed(0)}KB base64 · ${FPS}fps`)
  } else {
    log('FRONT 는 보내지 않는다 — HLS 로 이동했다(계약 2026-08-12). 옛 동작이 필요하면 --legacy-front')
  }
  if (STALL_SECONDS > 0) log(`열화상을 ${STALL_SECONDS}초마다 끊는다 — stale 판정 시험용`)
  log(`FE 를 이렇게 띄운다: VITE_WS_URL=ws://localhost:${PORT}/ws/control npm run dev`)
})
