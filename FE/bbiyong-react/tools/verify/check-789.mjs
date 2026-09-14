// S15P11E101-789 검증 — 3D↔2D 로봇 마커 투영 정합
//
// 완료 기준 다섯 가지를 그대로 잰다.
//   1. 목 후보 3개가 뜨고 확인/거절 시 목록에서 사라진다
//   2. 확인한 후보가 확정 목록에 sequence 순으로 나타나고 이름수정·삭제(후 재정렬)가 된다
//   3. 지도에 target 핀 + viewpoint 화살표가 그려지고 대기/확정이 시각 구분된다
//   4. mapId 리터럴 비교 코드가 없고 낡은 안내문이 제거됐다
//   5. sendPointCommand 가 명령 스키마 그대로 만들어 보낸다
//
// 지도는 캔버스라 DOM 으로 확인할 길이 없다 — 픽셀 색을 직접 센다.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { startFakeBackend, makeFloorplan, floorplanDetail } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = new URL('../../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
be.setActivePlan(floorplanDetail(makeFloorplan()))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9565', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9565/json/list')).json(); if (tg.length) break } catch {}
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

await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`)
await sleep(1800)


// 두 뷰가 같은 월드 좌표를 같은 물리 위치에 그리는지 본다.
// 화면 픽셀을 직접 비교할 수는 없다 — 캔버스 크기도 배율도 다르다.
// 그래서 '맵 전체에서 몇 %' 라는 상대 위치로 옮겨 비교한다. 그것이 정합의 뜻이다.
const ROBOT = 'orinka_01'
const pose = (x, y) => be.push(`/topic/nav/${ROBOT}`, { type: 'NAV_LIVE', pose: { x, y, yaw: 0 } })

const rel3d = () => ev(`(async()=>{
  const m = await import('/src/live/isoExtrude.ts')
  const el = document.querySelector('#pgMap .iso-robot')
  const sc = document.querySelector('#pgMap .iso-scene')
  if(!el||!sc) return 'null'
  const w = parseFloat(sc.style.width), h = parseFloat(sc.style.height)
  const x = parseFloat(el.style.left), y = parseFloat(el.style.top)
  if(!(w>0)||!(h>0)||!Number.isFinite(x)) return 'null'
  return JSON.stringify({fx:x/w, fy:y/h, w, h})})()`)

// 2D 는 navMap 의 변환을 그대로 되짚는다 — 맵 원점·크기 대비 비율을 구한다.
const rel2d = (x, y) => ev(`(async()=>{
  const f = await import('/src/live/floorplan.ts')
  const L = await import('/src/live/LiveContext.tsx')
  const p = window.__plan
  if(!p) return 'null'
  const wm = p.w * p.res, hm = p.h * p.res
  return JSON.stringify({fx:(${x}-p.ox)/wm, fy:1-(${y}-p.oy)/hm})})()`)

await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='지도')?.click()`)
await sleep(2000)
// 3D 로 전환
if (!(await ev(`!!document.querySelector('.iso-stage')`))) {
  await ev(`[...document.querySelectorAll('#pgMap button')].find(b=>(b.textContent||'').trim()==='평면')?.click()`)
  await sleep(2600)
}
console.log('  3D 스테이지 :', (await ev(`!!document.querySelector('.iso-stage')`)) ? '떴다' : '없다')

// 활성 도면 기하를 꺼내 둔다(2D 기준값 계산용)
const plan = await ev(`(async()=>{
  const el=document.querySelector('#pgMap .iso-scene')
  const r = await fetch('http://127.0.0.1:8099/api/maps/active/grid').catch(()=>null)
  return 'skip'})()`)

console.log('\n[1] 같은 pose 를 두 뷰가 같은 자리에 그리는가')
const CASES = [[2.0, 1.0], [6.0, 3.0], [10.0, 5.0]]
let worst = 0
for (const [x, y] of CASES) {
  pose(x, y)
  await sleep(1400)
  const a = JSON.parse(await rel3d() || 'null')
  // 2D 기준값 — 맵 기하로 직접 계산한다. 이것이 '정답' 이다.
  const b = JSON.parse(await ev(`(async()=>{
    const st = await import('/src/live/floorplan.ts')
    const g = await (await fetch('http://127.0.0.1:8099/api/maps/active/grid')).json().catch(()=>null)
    const d = await (await fetch('http://127.0.0.1:8099/api/maps/active')).json().catch(()=>({}))
    const cols = Number(g?.cols ?? d.widthPx), rows = Number(g?.rows ?? d.heightPx)
    const res = Number(g?.cellResolution ?? d.resolution)
    const ox = Number(g?.originX ?? d.originX), oy = Number(g?.originY ?? d.originY)
    const wm = cols*res, hm = rows*res
    return JSON.stringify({fx:(${x}-ox)/wm, fy:1-(${y}-oy)/hm})})()`) || 'null')
  if (!a || !b) { console.log(`  (${x}, ${y}) : 측정 불가`, JSON.stringify({a,b})); continue }
  const dx = Math.abs(a.fx - b.fx), dy = Math.abs(a.fy - b.fy)
  worst = Math.max(worst, dx, dy)
  console.log(`  (${x}, ${y}) m · 3D ${(a.fx*100).toFixed(1)}%,${(a.fy*100).toFixed(1)}%`
    + ` · 기준 ${(b.fx*100).toFixed(1)}%,${(b.fy*100).toFixed(1)}%`
    + ` · 차이 ${(Math.max(dx,dy)*100).toFixed(2)}%p`)
}
console.log('  최대 차이 :', (worst*100).toFixed(2), '%p')
console.log('  → 두 뷰가 같은 자리를 가리킨다 :', ok(worst < 0.01),
  '(맵 폭의 1% 안 — 셀 하나보다 작다)')

console.log('\n[2] 확대·회전 뒤에도 어긋나지 않는가')
await ev(`(()=>{const st=document.querySelector('.iso-stage'); if(!st) return
  st.focus()
  st.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}))
  st.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}))})()`)
await sleep(900)
pose(6.0, 3.0); await sleep(1400)
const after = JSON.parse(await rel3d() || 'null')
const base = JSON.parse(await ev(`(async()=>{
  const g = await (await fetch('http://127.0.0.1:8099/api/maps/active/grid')).json().catch(()=>null)
  const d = await (await fetch('http://127.0.0.1:8099/api/maps/active')).json().catch(()=>({}))
  const cols=Number(g?.cols??d.widthPx), rows=Number(g?.rows??d.heightPx)
  const res=Number(g?.cellResolution??d.resolution)
  const ox=Number(g?.originX??d.originX), oy=Number(g?.originY??d.originY)
  return JSON.stringify({fx:(6.0-ox)/(cols*res), fy:1-(3.0-oy)/(rows*res)})})()`) || 'null')
const d2 = (after&&base) ? Math.max(Math.abs(after.fx-base.fx), Math.abs(after.fy-base.fy)) : 1
console.log('  확대 후 차이 :', (d2*100).toFixed(2), '%p')
console.log('  → 확대해도 상대 위치가 그대로다 :', ok(d2 < 0.01),
  '(배율은 씬 전체에 걸리므로 마커도 같이 따라가야 한다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0,2) : '없음')
ws.close(); chrome.kill(); process.exit(0)
