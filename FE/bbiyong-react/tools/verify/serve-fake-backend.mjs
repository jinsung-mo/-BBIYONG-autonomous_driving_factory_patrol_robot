// 사람이 직접 둘러보기 위한 상주 가짜 백엔드.
// 로그인·이벤트·대시보드(REST) + 텔레메트리·SLAM 맵·경보(STOMP)를 계속 흘린다.
//
// 로봇 동작은 cloud_bridge.translate_command 규칙을 따른다:
//   ESTOP → estop=ENGAGED · DRIVE → RELEASED · SET_MODE → 무시(현재 실서버와 동일)
// HANDLE_SET_MODE=1 로 띄우면 SET_MODE autonomy 로도 해제된다(로봇 구현 후 모습).
import http from 'node:http'
import { startFakeBackend } from './fake-backend.mjs'

const be = await startFakeBackend(8099)
const HANDLE_SET_MODE = process.env.HANDLE_SET_MODE === '1'
console.log('가짜 백엔드 기동 — http://localhost:8099 (REST) · ws://localhost:8099/ws/control (STOMP)')
console.log('  로그인은 아무 이메일/비밀번호나 통과합니다. viewer 가 들어간 이메일은 뷰어 권한.')
console.log(`  SET_MODE 처리: ${HANDLE_SET_MODE ? '함(로봇 구현 후)' : '안 함(현재 실서버와 동일)'}`)

// ---- 합성 SLAM 맵 (60x48, 5cm/셀) ----
const W = 60, H = 48, RES = 0.05, OX = -1.5, OY = -1.2
const grid = new Array(W * H)
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    const edge = r === 0 || c === 0 || r === H - 1 || c === W - 1
    const pillar = r > 12 && r < 20 && c > 18 && c < 26
    grid[r * W + c] = edge || pillar ? 100 : (r > H - 8 && c < 12 ? -1 : 0)
  }
}
// run-length 로 접는다 (서버 계약과 동일한 cells 배열)
const cells = []
let v = grid[0], n = 0
for (let i = 0; i < grid.length; i++) {
  if (grid[i] === v) n++
  else { cells.push(v, n); v = grid[i]; n = 1 }
}
cells.push(v, n)

let t = 0
let seq = 1
let estop = 'RELEASED'
let seen = 0

// 로봇 흉내 — 제어 명령을 읽어 estop 상태를 바꾼다
function pumpCommands() {
  for (; seen < be.sends.length; seen++) {
    let body = null
    try { body = JSON.parse(be.sends[seen].body) } catch { continue }
    const cmd = (body.command || '').toUpperCase()
    if (cmd === 'ESTOP') estop = 'ENGAGED'
    else if (cmd === 'DRIVE') estop = 'RELEASED'
    else if (cmd === 'SET_MODE' && HANDLE_SET_MODE && body.mode === 'autonomy') estop = 'RELEASED'
  }
}

// 맵 + 위치/스캔
setInterval(() => {
  t++
  pumpCommands()
  const x = Math.cos(t * 0.05) * 0.5
  const y = Math.sin(t * 0.05) * 0.4
  if (t % 10 === 1) {
    be.push('/topic/nav/orinka_01', {
      type: 'MAP', robotId: 'orinka_01', sequence: seq++,
      width: W, height: H, resolution: RES, originX: OX, originY: OY, cells,
    })
  }
  be.push('/topic/nav/orinka_01', {
    type: 'NAV_LIVE', robotId: 'orinka_01',
    pose: { x, y, yaw: t * 0.05 },
    scan: { angleMin: -Math.PI, angleMax: Math.PI, ranges: Array.from({ length: 72 }, (_, i) => 1.2 + 0.4 * Math.sin(i / 5 + t / 8)) },
  })
}, 330)

// 텔레메트리
setInterval(() => {
  pumpCommands()
  be.push('/topic/robots', {
    robotId: 'orinka_01', status: estop === 'ENGAGED' ? 'MANUAL_CONTROL' : 'AUTO_PATROL',
    battery: Number((72 - (t % 600) * 0.01).toFixed(1)),
    speed: estop === 'ENGAGED' ? 0 : 0.12,
    estop, commLatencyMs: 24 + (t % 7),
    location: { x: Number((Math.cos(t * 0.05) * 0.5).toFixed(2)), y: Number((Math.sin(t * 0.05) * 0.4).toFixed(2)) },
    capabilities: { lidar_map: 'online', nav: 'online', camera: 'online', drive: 'online', fire: 'stale' },
  })
}, 1000)

// 이따금 경보 — 화면 팝업과 이벤트 로그 동작을 볼 수 있게
setInterval(() => {
  be.push('/topic/alerts', {
    type: 'OVERHEAT', robotId: 'orinka_01', equipmentId: 'panel_B',
    temperature: Number((58 + Math.random() * 6).toFixed(1)), threshold: 55,
    level: 'WARNING', timestamp: new Date().toISOString(),
  })
}, 45000)

// 화재는 자동으로 반복하지 않는다 — 확인할 때까지 화면이 점멸하므로(S15P11E101-643)
// 주기적으로 터뜨리면 둘러보기가 어렵다. 기동 15초 뒤 한 번만 보내고, 그 뒤로는 요청할 때만.
const pushFire = () => be.push('/topic/alerts', {
  type: 'FIRE', robotId: 'orinka_01', confidence: 0.62 + Math.random() * 0.3,
  level: 'CRITICAL', x: 8.4, y: 3.1, timestamp: new Date().toISOString(),
})
setTimeout(pushFire, 15000)

// 사람이 원할 때 다시 터뜨릴 수 있게 — http://localhost:8100/fire
http.createServer((req, res) => {
  if (req.url === '/fire') { const n = pushFire(); res.writeHead(200); res.end(`FIRE → ${n}명\n`); return }
  if (req.url === '/heat') {
    const n = be.push('/topic/alerts', {
      type: 'OVERHEAT', robotId: 'orinka_01', equipmentId: 'panel_B',
      temperature: 61.4, threshold: 55, level: 'WARNING', timestamp: new Date().toISOString(),
    })
    res.writeHead(200); res.end(`OVERHEAT → ${n}명\n`); return
  }
  res.writeHead(404); res.end('/fire · /heat\n')
}).listen(8100, '127.0.0.1', () => console.log('  경보 수동 발생 — http://localhost:8100/fire · /heat'))

process.on('SIGINT', async () => { await be.close(); process.exit(0) })
