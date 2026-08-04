// S15P11E101-627 검증 — STOMP 제어 채널 계약
//   CONNECT 인증 · 만료 시 refresh 후 재연결 · 네 목적지의 명령 · ESTOP active:true · tilt 범위
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9401', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9401/json/list')).json(); if (tg.length) break } catch {}
  await sleep(500)
}
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value ?? '').join(' '))
}
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pending.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
const frames = (dest) => be.sends.filter((s) => s.destination === dest)
const dropped = () => be.sends.filter((s) => !s.relayed)

// 로봇 흉내 — capabilities 를 줘야 조작 패널이 열린다
let estop = 'RELEASED', seen = 0
const robot = setInterval(() => {
  for (; seen < be.sends.length; seen++) {
    const f = be.sends[seen]
    if (!f.relayed) continue
    const c = String(f.payload?.command || '').toUpperCase()
    if (c === 'ESTOP') estop = 'ENGAGED'
    else if (c === 'DRIVE') estop = 'RELEASED'
    else if (c === 'SET_MODE' && f.payload?.mode === 'autonomy') estop = 'RELEASED'
  }
  be.push('/topic/robots', {
    robotId: 'orinka_01', status: 'AUTO_PATROL', battery: 71, speed: 0.1, estop, commLatencyMs: 27,
    capabilities: { lidar_map: 'online', camera: 'online', drive: 'online' },
  })
}, 400)

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password');
  document.querySelector('.auth-submit').click()})()`)
await sleep(3600)

console.log('\n[1] CONNECT 에 Authorization: Bearer 가 실리는가')
console.log('  CONNECT 헤더 :', JSON.stringify(be.connectHeaders?.() ?? '(미노출)'))
console.log('  연결 상태 :', await ev(`[...document.querySelectorAll('#pControl h3 .k')].map(s=>s.textContent.trim()).join(' / ')`))
console.log('  → LIVE 연결 :', ok((await ev(`[...document.querySelectorAll('#pControl h3 .k')].map(s=>s.textContent).join()`)).includes('LIVE')))

console.log('\n[2] drive — /app/control/drive')
await ev(`document.activeElement?.blur()`)
// 수동 모드로 바꾸고 W 를 눌러 주행을 낸다(S15P11E101-513: 순찰 모드에서는 나가지 않는다)
await key('keyDown', ' ', 'Space', 32); await key('keyUp', ' ', 'Space', 32); await sleep(800)
const d0 = frames('/app/control/drive').length
await key('keyDown', 'w', 'KeyW', 87); await sleep(400); await key('keyUp', 'w', 'KeyW', 87); await sleep(500)
const drives = frames('/app/control/drive').slice(d0)
console.log('  발행 :', drives.length, '건 ·', JSON.stringify(drives[0]?.payload))
console.log('  → linear/angular 포함 :', ok(drives.length > 0 && 'linear' in (drives[0]?.payload || {}) && 'angular' in (drives[0]?.payload || {})))
console.log('  → 모두 중계됨 :', ok(drives.every((f) => f.relayed)))

console.log('\n[3] mode — SET_MODE 와 ESTOP(active:true 만)')
const m0 = frames('/app/control/mode').length
await ev(`[...document.querySelectorAll('#pControl .dbtn.stop')][0].click()`); await sleep(900)
const modes = frames('/app/control/mode').slice(m0)
console.log('  ESTOP :', JSON.stringify(modes[0]?.payload))
console.log('  → active:true :', ok(modes[0]?.payload?.command === 'ESTOP' && modes[0]?.payload?.active === true))
console.log('  → 중계됨 :', ok(modes[0]?.relayed))
// DoD: 'ESTOP 은 active:true 만 전송된다' — 앱이 만든 ESTOP 프레임을 전수 확인한다
const allEstop = frames('/app/control/mode').map((f) => f.payload).filter((p) => p?.command === 'ESTOP')
console.log('  ESTOP 프레임 :', allEstop.length, '건 · active 값', [...new Set(allEstop.map((p) => p.active))].join(','))
console.log('  → 전부 active:true :', ok(allEstop.length > 0 && allEstop.every((p) => p.active === true)))

console.log('\n[4] camera — /app/control/camera 로 나가고 버려지지 않는가')
const c0 = be.sends.length
await ev(`[...document.querySelectorAll('#camTilt .dbtn')][1].click()`)   // ▲ 위로
await sleep(900)
const cam = be.sends.slice(c0).filter((s) => String(s.body).includes('tilt'))
console.log('  목적지 :', cam[0]?.destination, '· payload', JSON.stringify(cam[0]?.payload))
console.log('  → /app/control/camera :', ok(cam[0]?.destination === '/app/control/camera'))
console.log('  → 버려지지 않음 :', ok(cam[0]?.relayed === true), cam[0]?.reason || '')
console.log('  → operation 으로 새지 않음 :', ok(!be.sends.slice(c0).some((s) => s.destination === '/app/control/operation' && String(s.body).includes('tilt'))))

console.log('\n[5] tilt 범위 — 서버 가동범위(-30~45)와 화면이 맞는가')
const range = await ev(`document.querySelector('#camTilt .camtilt-range')?.textContent?.trim()
  || document.querySelector('#camTilt .spdbar')?.getAttribute('aria-valuemax')`)
console.log('  화면 범위 :', range)
const vmax = await ev(`document.querySelector('#camTilt .spdbar')?.getAttribute('aria-valuemax')`)
const vmin = await ev(`document.querySelector('#camTilt .spdbar')?.getAttribute('aria-valuemin')`)
console.log('  aria :', vmin, '~', vmax)
console.log('  → 상한 45 :', ok(Number(vmax) === 45), '(예전 30 이라 30~45 를 화면이 막고 있었다)')
console.log('  → 하한 -30 :', ok(Number(vmin) === -30))
// 상한까지 올려 본다 — 클램프가 서버에서도 걸리는지
const t0 = be.sends.length
for (let i = 0; i < 25; i++) { await ev(`[...document.querySelectorAll('#camTilt .dbtn')][1].click()`); await sleep(60) }
await sleep(900)
const tilts = be.sends.slice(t0).filter((s) => s.destination === '/app/control/camera')
const last = tilts[tilts.length - 1]
console.log('  마지막 tilt :', last?.payload?.tilt, '· 중계 :', last?.relayed)
console.log('  → 범위를 넘지 않음 :', ok(tilts.every((f) => f.payload?.tilt <= 45 && f.payload?.tilt >= -30)))

console.log('\n[6] operation — START_MAPPING / STOP_MAPPING / SAVE_MAP / NAVIGATE')
await ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`); await sleep(2000)
const o0 = be.sends.length
await ev(`document.querySelector('#btnStartMapping')?.click()`); await sleep(500)
await ev(`document.querySelector('#btnStartMappingOk')?.click()`); await sleep(1200)
const ops1 = be.sends.slice(o0).filter((s) => s.destination === '/app/control/operation')
console.log('  START_MAPPING :', JSON.stringify(ops1[0]?.payload), '· 중계', ops1[0]?.relayed)
console.log('  → 중계됨 :', ok(ops1[0]?.payload?.command === 'START_MAPPING' && ops1[0]?.relayed))
const stopBtn = await ev(`!!document.querySelector('#btnStopMapping')`)
console.log('  중단 버튼 노출 :', ok(stopBtn), '(매핑 중에만 보인다)')
if (stopBtn) {
  const s0 = be.sends.length
  await ev(`document.querySelector('#btnStopMapping')?.click()`); await sleep(1000)
  const ops2 = be.sends.slice(s0).filter((s) => s.destination === '/app/control/operation')
  console.log('  STOP_MAPPING :', JSON.stringify(ops2[0]?.payload), '· 중계', ops2[0]?.relayed)
  console.log('  → 중계됨 :', ok(ops2[0]?.payload?.command === 'STOP_MAPPING' && ops2[0]?.relayed))
}
const { data: shot } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'S627-ops.png', Buffer.from(shot, 'base64'))

console.log('\n[7] 버려진 제어 명령이 하나도 없는가')
const bads = dropped().filter((s) => s.reason && !s.reason.includes('active'))
console.log('  버려진 프레임 :', bads.length, '건', bads.map((b) => `${b.destination}: ${b.reason}`).join(' · '))
console.log('  → 없음 :', ok(bads.length === 0))

console.log('\n[8] 일시적 인증 거부 — 갱신 한 번으로 회복되는가')
// 관제 탭으로 돌아온다 — #pControl 은 그 탭에만 있다
await ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()==='관제')?.click()`)
await sleep(1500)
const r0 = be.refreshCount()
be.rejectStomp(true)
be.dropStompSockets()
await sleep(3000)
be.rejectStomp(false)          // 갱신이 도는 사이 서버가 정상으로 돌아온다
await sleep(6000)
console.log('  refresh 호출 :', be.refreshCount() - r0, '회')
console.log('  → 갱신 시도 :', ok(be.refreshCount() - r0 >= 1))
console.log('  → 갱신 폭주 없음 :', ok(be.refreshCount() - r0 <= 2))
console.log('  배지 :', await ev(`[...document.querySelectorAll('#pControl h3 .k')].map(s=>s.textContent.trim()).join(' / ')`))
console.log('  → 세션 유지 :', ok(await ev(`!!document.querySelector('#pControl')`)), '(로그인 화면으로 튕기지 않는다)')

console.log('\n[9] 갱신해도 계속 거부되면 로그인 화면으로 보내는가')
const r1 = be.refreshCount()
be.rejectStomp(true)
be.dropStompSockets()
// 유예(VITE_STOMP_AUTH_GRACE_SEC, 기본 20초)가 지나야 로그아웃된다
await sleep(26000)
console.log('  refresh 호출 :', be.refreshCount() - r1, '회 (한 번만 시도해야 한다)')
console.log('  → 한 번만 :', ok(be.refreshCount() - r1 <= 1))
const onLogin = await ev(`!!document.querySelector('.auth-card')`)
console.log('  → 로그인 화면 :', ok(onLogin), '(갱신으로 풀 수 없는 문제다)')
console.log('  안내 :', await ev(`document.querySelector('.auth-note, .auth-card .form-msg, .authmsg')?.textContent?.trim() || '(없음)'`))
be.rejectStomp(false)

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
clearInterval(robot)
ws.close(); chrome.kill(); await be.close(); process.exit(0)
