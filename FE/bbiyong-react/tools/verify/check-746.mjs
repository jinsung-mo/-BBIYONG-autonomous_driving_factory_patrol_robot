// S15P11E101-746 검증 — 지도 표시 180도 회전 정합
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 실시간 SLAM · 3D 도면 · 로봇 마커가 같은 방향을 본다
//   2. 로봇 위치가 회전 후에도 정확한 자리에 남는다
//
// 이 티켓의 위험은 '지도만 돌고 로봇은 안 도는' 어긋남이다. 그래서 화면을 눈으로
// 보지 않고, 같은 월드 좌표를 넣었을 때 지도 위 픽셀과 마커 픽셀이 함께 움직이는지를 잰다.
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
  '--remote-debugging-port=9485', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9485/json/list')).json(); if (tg.length) break } catch {}
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

const pose = (x, y, yaw = 0) => be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x, y, yaw } })
const marker = () => ev(`(()=>{const e=document.querySelector('.iso-robot'); if(!e) return null
  return {left:parseFloat(e.style.left), top:parseFloat(e.style.top), shown:e.style.display!=='none'}})()`)
const scene = () => ev(`(()=>{const e=document.querySelector('.iso-scene'); if(!e) return null
  return getComputedStyle(e).transform})()`)

console.log('\n[1] 3D 씬이 180도 돌아 있는가')
// 씬은 rotateX(tilt) 다음 rotateZ(spin) 을 건다. 두 회전의 곱에서
//   m11 = cos(spin),  m21 = -sin(spin)
// 이므로 atan2(-m21, m11) 이면 기울기가 섞이지 않은 순수 spin 이 나온다.
const spinDeg = await ev(`(()=>{const e=document.querySelector('.iso-scene'); if(!e) return null
  const m=new DOMMatrix(getComputedStyle(e).transform)
  return Math.round(Math.atan2(-m.m21, m.m11) * 180 / Math.PI)})()`)
console.log('  씬 spin :', spinDeg, '도 (기대 156 = -24 + 180)')
console.log('  → 기본 회전에 180 이 더해져 있다 :', ok(spinDeg !== null && Math.abs(spinDeg - 156) < 0.5))

console.log('\n[2] 로봇이 회전 후에도 올바른 셀에 오는가')
// 마커 좌표는 도면 픽셀 공간이고 씬 전체가 함께 돈다 — 픽셀 값은 회전과 무관하게 같아야 한다.
// 값이 달라지면 지도와 마커가 서로 다른 좌표계를 쓰고 있다는 뜻이다.
for (const c of [{ x: 3.0, y: 4.2, px: 100, py: 126 }, { x: 5.0, y: 6.0, px: 140, py: 90 }]) {
  pose(c.x, c.y)
  await sleep(2200)
  const m = await marker()
  const hit = m?.shown && Math.abs(m.left - c.px) < 1 && Math.abs(m.top - c.py) < 1
  console.log(`  (${c.x}, ${c.y}) m → 기대 (${c.px}, ${c.py})px · 실제 (${m?.left?.toFixed(1)}, ${m?.top?.toFixed(1)})px`, ok(hit))
}
console.log('  → 마커가 씬 안에 있다 :', ok(await ev(`!!document.querySelector('.iso-scene .iso-robot')`)),
  '(밖에 있으면 지도만 돌고 로봇은 제자리에 남는다)')

console.log('\n[3] 실시간 SLAM 뷰도 같은 각도로 도는가')
// 2D 로 내려 SLAM 캔버스를 본다
await ev(`[...document.querySelectorAll('#pgMap .mapview')].find(b=>/평면|입체/.test(b.textContent))?.click()`)
await sleep(1200)
const rot = await ev(`(async()=>{
  const m = await import('/src/live/navMap.ts')
  return m.DISPLAY_ROT})()`)
console.log('  DISPLAY_ROT :', rot, '(π =', Math.PI.toFixed(4), ')')
console.log('  → SLAM 과 3D 가 같은 상수를 쓴다 :', ok(Math.abs((rot ?? 0) - Math.PI) < 1e-6),
  '(두 화면이 다른 각도를 보면 방향 감각을 다시 잡아야 한다)')

console.log('\n[4] 찍은 자리와 가는 자리가 같은가 (역변환)')
// 표시 회전을 되돌리지 않으면 조작자가 찍은 곳과 로봇이 가는 곳이 정반대가 된다.
const inv = await ev(`(async()=>{
  const m = await import('/src/live/navMap.ts')
  const view = {x:100, y:300, s:20, init:true}
  const cv = {width:600, height:400}
  // 월드 (2,1) 을 화면 픽셀로 옮긴 뒤(표시 회전 포함), 다시 월드로 되돌린다
  const sx = view.x + 2*view.s, sy = view.y - 1*view.s
  const mx = cv.width/2, my = cv.height/2
  const a = Math.PI
  const px = mx + (sx-mx)*Math.cos(a) - (sy-my)*Math.sin(a)
  const py = my + (sx-mx)*Math.sin(a) + (sy-my)*Math.cos(a)
  const w = m.canvasToWorld(view, null, false, px, py, cv)
  return {x:Math.round(w.x*1000)/1000, y:Math.round(w.y*1000)/1000}})()`)
console.log('  월드 (2, 1) → 화면 → 월드 :', JSON.stringify(inv))
console.log('  → 제자리로 돌아온다 :', ok(inv && Math.abs(inv.x - 2) < 0.01 && Math.abs(inv.y - 1) < 0.01))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M746-rotated.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')

ws.close(); chrome.kill()
process.exit(0)
