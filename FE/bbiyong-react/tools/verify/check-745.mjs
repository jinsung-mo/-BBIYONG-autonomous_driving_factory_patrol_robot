// S15P11E101-745 검증 — 3D 도면 위 로봇 입체 마커
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 로봇이 올바른 셀에 표시되고 yaw 방향이 실제 주행과 일치한다
//   2. 실시간 이동이 부드럽게 반영된다
//
// '부드럽다' 는 눈으로 못 재므로, 값이 튀는지로 잰다. 한 번에 목표로 점프하면
// 중간 프레임이 없다 — 목표를 멀리 옮긴 직후 두 프레임을 떠서, 마커가 아직
// 목표에 닿지 않았고 그러면서 출발점보다는 가까워졌는지를 본다.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend, makeFloorplan, floorplanDetail } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
be.setActivePlan(floorplanDetail(makeFloorplan()))

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9481', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9481/json/list')).json(); if (tg.length) break } catch {}
  await sleep(500)
}
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pend = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description)
}
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pend.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')
  localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
  localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(5000)

const marker = () => ev(`(()=>{const e=document.querySelector('.iso-robot'); if(!e) return null
  const yawOf=(el)=>{const v=getComputedStyle(el).getPropertyValue('--yaw').trim(); return v?parseFloat(v):null}
  const body=e.querySelector('.iso-robot-body'), nose=e.querySelector('.iso-robot-nose')
  return {left:parseFloat(e.style.left), top:parseFloat(e.style.top), shown:e.style.display!=='none',
    yaw:yawOf(e), off:e.classList.contains('off'),
    hasBody:!!body, hasNose:!!nose, hasDot:!!e.querySelector('.iso-robot-dot'),
    bodyT:body?getComputedStyle(body).transform:null,
    noseT:nose?getComputedStyle(nose).transform:null,
    opacity:getComputedStyle(e).opacity}})()`)

const pose = (x, y, yaw) => be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x, y, yaw } })

console.log('\n[1] 마커가 입체로 서 있는가')
pose(3.0, 4.2, 0)
await sleep(1400)
let m = await marker()
console.log('  구성 :', JSON.stringify({ body: m?.hasBody, nose: m?.hasNose, dot: m?.hasDot }))
console.log('  → 몸체·코·표시등이 모두 있다 :', ok(!!m?.hasBody && !!m?.hasNose && !!m?.hasDot))
console.log('  → 벽 위로 띄운다 :', ok(await ev(`parseFloat(document.querySelector('.iso-robot').style.getPropertyValue('--rz'))>0`)))

console.log('\n[2] 올바른 셀에 오는가 (도면 320x240 · res 0.05 · origin -2.0,-1.5)')
for (const t of [{ x: 3.0, y: 4.2, px: 100, py: 126 }, { x: 5.0, y: 6.0, px: 140, py: 90 }]) {
  pose(t.x, t.y, 0)
  await sleep(1500)   // 보간이 목표에 닿을 시간을 준다
  m = await marker()
  const hit = m?.shown && Math.abs(m.left - t.px) < 1 && Math.abs(m.top - t.py) < 1
  console.log(`  (${t.x}, ${t.y}) m → 기대 (${t.px}, ${t.py})px · 실제 (${m?.left?.toFixed(1)}, ${m?.top?.toFixed(1)})px`, ok(hit))
}

console.log('\n[3] yaw 가 실제 주행 방향과 맞는가')
// 화면 y 축은 아래로 자라므로 CSS 회전은 부호가 뒤집힌다 — --yaw 는 -pose.yaw 여야 한다
for (const y of [0, Math.PI / 2, -Math.PI / 2]) {
  pose(3.0, 4.2, y)
  await sleep(1600)
  m = await marker()
  const want = -y
  let d = (m?.yaw ?? 0) - want
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  console.log(`  pose.yaw ${y.toFixed(2)} → --yaw ${m?.yaw?.toFixed(3)} (기대 ${want.toFixed(3)})`, ok(Math.abs(d) < 0.05))
}
console.log('  → 몸체와 코가 함께 돈다 :', ok(!!m?.bodyT && m.bodyT !== 'none' && !!m?.noseT && m.noseT !== 'none'))

console.log('\n[4] 각도가 짧은 쪽으로 감기는가')
// +π 에서 -π 로 갈 때 한 바퀴를 거꾸로 돌면 중간에 0 부근을 지난다
pose(3.0, 4.2, Math.PI - 0.05)
await sleep(1600)
pose(3.0, 4.2, -Math.PI + 0.05)
await sleep(120)
const mid = await marker()
console.log('  경계를 넘는 중 --yaw :', mid?.yaw?.toFixed(3))
console.log('  → 0 근처를 지나지 않는다 :', ok(Math.abs(mid?.yaw ?? 0) > 2.5), '(지나면 한 바퀴 거꾸로 돈 것이다)')

console.log('\n[5] 실시간 이동이 부드러운가')
pose(-2.0, -1.5, 0)   // 좌하단 원점으로 보내 놓고
await sleep(1600)
const from = await marker()
pose(5.0, 6.0, 0)     // 대각선 끝으로 옮긴다
await sleep(80)
const f1 = await marker()
await sleep(120)
const f2 = await marker()
const target = { x: 140, y: 90 }
const dist = (p) => Math.hypot(p.left - target.x, p.top - target.y)
console.log('  출발', `(${from?.left}, ${from?.top})`, '→ 80ms', `(${f1?.left?.toFixed(1)}, ${f1?.top?.toFixed(1)})`,
  '→ 200ms', `(${f2?.left?.toFixed(1)}, ${f2?.top?.toFixed(1)})`)
console.log('  → 한 번에 점프하지 않는다 :', ok(dist(f1) > 1), '(중간 프레임이 있어야 순찰이 보인다)')
console.log('  → 목표로 다가간다 :', ok(dist(f2) < dist(f1)))
await sleep(1500)
const settled = await marker()
console.log('  → 결국 목표에 닿는다 :', ok(dist(settled) < 1), `(잔차 ${dist(settled).toFixed(2)}px)`)

console.log('\n[6] 로봇이 꺼지면 마커를 흐리는가')
be.push('/topic/robots', { type: 'STATE_UPDATE', robotId: 'orinka_01', online: false })
await sleep(1200)
m = await marker()
console.log('  off 클래스 :', m?.off, '· 불투명도 :', m?.opacity)
console.log('  → 흐려진다 :', ok(m?.off === true && Number(m?.opacity) < 0.6))
console.log('  → 지우지는 않는다 :', ok(m?.shown === true), '(어디서 멈췄는지는 남아야 한다)')
be.push('/topic/robots', { type: 'STATE_UPDATE', robotId: 'orinka_01', online: true })
await sleep(1200)
console.log('  → 돌아오면 원래대로 :', ok((await marker())?.off === false))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'R745-marker.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')

ws.close(); chrome.kill()
process.exit(0)
