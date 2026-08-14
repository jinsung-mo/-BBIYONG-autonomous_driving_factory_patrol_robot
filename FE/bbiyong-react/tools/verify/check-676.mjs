// S15P11E101-676 검증 — 도면 압출 2.5D 뷰
//
// 완료 기준 세 가지를 그대로 잰다.
//   1. 활성 도면(FLOORPLAN)이 압출 2.5D 로 렌더되고 드래그 회전·휠 줌이 동작한다
//   2. 매핑 완료(FLOORPLAN_READY) 시 새 도면으로 자동 갱신된다
//   3. 로봇 실시간 위치 마커가 압출 씬 위 올바른 좌표에 표시된다
//
// 좌표는 눈으로 보지 않고 계산값과 대조한다 — 기울인 화면에서는 눈이 못 잡는다.
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
  '--remote-debugging-port=9467', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9467/json/list')).json(); if (tg.length) break } catch {}
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value ?? '').join(' '))
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

const scene = () => ev(`(()=>{const e=document.querySelector('.iso-scene'); if(!e) return null
  const s=getComputedStyle(e)
  return {transform:s.transform, w:e.style.width, h:e.style.height}})()`)
const dragBy = async (dx, dy) => {
  const c = await ev(`(()=>{const e=document.querySelector('.iso-stage').getBoundingClientRect()
    return {x:Math.round(e.left+e.width/2), y:Math.round(e.top+e.height/2)}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + dx, y: c.y + dy, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + dx, y: c.y + dy, button: 'left', clickCount: 1 })
  await sleep(400)
}

console.log('\n[1] 활성 도면이 압출 2.5D 로 렌더되는가')
console.log('  압출 씬 :', ok(await ev(`!!document.querySelector('.iso-stage')`)))
const nLayers = await ev(`document.querySelectorAll('.iso-wall').length`)
console.log('  벽 층 수 :', nLayers)
console.log('  → 여러 층으로 쌓임 :', ok(nLayers >= 20), '(층 하나면 압출이 아니다)')
const layerZ = await ev(`(()=>{const ls=[...document.querySelectorAll('.iso-wall')]
  const z=(el)=>{const m=/translateZ\\(([-\\d.]+)px\\)/.exec(el.style.transform); return m?Number(m[1]):null}
  return {first:z(ls[0]), last:z(ls[ls.length-1])}})()`)
console.log('  z 범위 :', layerZ?.first, '→', layerZ?.last)
console.log('  → z 축으로 쌓임 :', ok(layerZ && layerZ.last > layerZ.first))
const bright = await ev(`(()=>{const ls=[...document.querySelectorAll('.iso-wall')]
  const lum=(el)=>{const m=/(\\d+(?:\\.\\d+)?)%\\)$/.exec(getComputedStyle(el).backgroundColor) ; return getComputedStyle(el).backgroundColor}
  return {bottom:lum(ls[0]), top:lum(ls[ls.length-1])}})()`)
console.log('  색 :', bright?.bottom, '→', bright?.top)
console.log('  → 위로 갈수록 밝다 :', ok(bright && bright.bottom !== bright.top))
const masked = await ev(`(()=>{const e=document.querySelector('.iso-wall'); const s=getComputedStyle(e)
  return /url\\(/.test(s.webkitMaskImage||s.maskImage||'')})()`)
console.log('  → 벽 마스크 적용 :', ok(masked), '(벽 픽셀만 켜진 이미지)')
const preserve = await ev(`getComputedStyle(document.querySelector('.iso-scene')).transformStyle`)
console.log('  → preserve-3d :', ok(preserve === 'preserve-3d'))
{
  const r = await ev(`(()=>{const q=document.querySelector('#pMap .vwrap').getBoundingClientRect()
    return {x:Math.round(q.left),y:Math.round(q.top),width:Math.round(q.width),height:Math.round(q.height),scale:2}})()`)
  const c = await send('Page.captureScreenshot', { format: 'png', clip: r })
  writeFileSync(OUT + 'I-iso-map.png', Buffer.from(c.data, 'base64'))
}

console.log('\n[2] 드래그 회전 · 휠 줌')
const before = await scene()
await dragBy(120, -40)
const afterDrag = await scene()
console.log('  드래그 전 :', String(before?.transform).slice(0, 44))
console.log('  드래그 후 :', String(afterDrag?.transform).slice(0, 44))
console.log('  → 회전한다 :', ok(before?.transform !== afterDrag?.transform))
const c = await ev(`(()=>{const e=document.querySelector('.iso-stage').getBoundingClientRect()
  return {x:Math.round(e.left+e.width/2), y:Math.round(e.top+e.height/2)}})()`)
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -120 })
await sleep(400)
const afterZoom = await scene()
console.log('  → 휠로 확대된다 :', ok(afterDrag?.transform !== afterZoom?.transform))
// 방향키로도 돌아야 한다 — 마우스에만 길을 두지 않는다
await ev(`document.querySelector('.iso-stage')?.focus()`)
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
await sleep(400)
console.log('  → 방향키로도 돌아간다 :', ok((await scene())?.transform !== afterZoom?.transform))
// 값이 멈출 때까지 기다린다. 고정 대기로 재면 애니메이션·보간이 끝나기 전에 읽어
// 같은 코드가 돌 때마다 결과가 달라진다 — 이 검사가 오래 플레이키했던 이유다.
// (S15P11E101-748 이 씬 전환에 0.32초를, 745 가 마커에 보간을 넣었다.)
// 보간은 값이 점점 작게 계속 바뀌어 '정확히 멈추는' 순간이 없다. 그래서 '같아질
// 때까지' 가 아니라 '조건을 만족할 때까지' 기다린다 — 단언과 같은 조건을 쓴다.
const waitFor = async (pred, tries = 60, gap = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return true
    await sleep(gap)
  }
  return false
}
await ev(`[...document.querySelectorAll('.iso-reset')][0]?.click()`)
const backToFront = await waitFor(async () => (await scene())?.transform === before?.transform)
console.log('  → 정면으로 되돌아온다 :', ok(backToFront))

console.log('\n[3] 로봇 실시간 위치가 올바른 좌표에 오는가')
// 도면 메타: 320x240px · res 0.05 · origin(-2.0,-1.5) · yaw 0 · 축소 없음(긴 변 320 < 720)
//   px = (x - ox)/res           py = h - (y - oy)/res
const cases = [
  { x: 3.0, y: 4.2, px: 100, py: 126 },
  { x: -2.0, y: -1.5, px: 0, py: 240 },   // 원점 = 좌하단
  { x: 5.0, y: 6.0, px: 140, py: 90 },
]
for (const t of cases) {
  be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x: t.x, y: t.y, yaw: 0.6 } })
  // S15P11E101-745 부터 마커는 목표로 보간해 다가간다. 자리는 여전히 정확해야 하지만
  // 즉시는 아니다 — 수렴할 시간을 주고 정밀도는 그대로 잰다.
  // 마커도 보간이 목표에 닿을 때까지 기다린다 — 자리는 정확해야 하지만 즉시는 아니다.
  await waitFor(async () => await ev(`(()=>{const e=document.querySelector('.iso-robot')
    if(!e) return false
    return Math.abs(parseFloat(e.style.left) - ${'${t.px}'}) < 0.5
      && Math.abs(parseFloat(e.style.top) - ${'${t.py}'}) < 0.5})()`))
  const m = await ev(`(()=>{const e=document.querySelector('.iso-robot'); if(!e) return null
    return {left:parseFloat(e.style.left), top:parseFloat(e.style.top), shown:e.style.display!=='none'}})()`)
  const hit = m && m.shown && Math.abs(m.left - t.px) < 0.5 && Math.abs(m.top - t.py) < 0.5
  console.log(`  (${t.x}, ${t.y}) m → 기대 (${t.px}, ${t.py})px · 실제 (${m?.left}, ${m?.top})px`, ok(hit))
}
const lifted = await ev(`(()=>{const e=document.querySelector('.iso-robot')
  const rz=e.style.getPropertyValue('--rz'); const t=getComputedStyle(e).transform
  return {rz, hasZ:/matrix3d/.test(t)}})()`)
console.log('  띄운 높이 :', lifted?.rz)
console.log('  → 벽 위로 띄운다 :', ok(parseFloat(lifted?.rz) > 0), '(바닥에 붙이면 벽에 가린다)')

console.log('\n[4] 매핑 완료 시 새 도면으로 갱신되는가')
const beforeSize = await scene()
// 크기가 다른 새 도면으로 갈아 끼우고 FLOORPLAN_READY 를 쏜다
be.setActivePlan({ ...floorplanDetail(makeFloorplan(400, 300), 'fp2'), widthPx: 400, heightPx: 300 })
be.push('/topic/mapping', { type: 'FLOORPLAN_READY', robotId: 'orinka_01', mapId: 'fp2', imageUrl: '/api/maps/fp2/image' })
for (let i = 0; i < 24; i++) { if ((await scene())?.w !== beforeSize?.w) break; await sleep(500) }
const afterReady = await scene()
console.log('  씬 크기 :', beforeSize?.w, '×', beforeSize?.h, '→', afterReady?.w, '×', afterReady?.h)
console.log('  → 새 도면으로 다시 세운다 :', ok(afterReady?.w !== beforeSize?.w))
console.log('  → 여전히 압출 상태 :', ok((await ev(`document.querySelectorAll('.iso-wall').length`)) >= 20))

console.log('\n[5] RAW 점유격자는 압출하지 않는다')
// 미탐색이 회색이라 '밝기<128' 이 벽과 미탐색을 구분하지 못한다 — 도면 전체가 기둥이 된다
be.setActivePlan({ ...floorplanDetail(makeFloorplan(), 'raw1'), kind: 'RAW' })
be.push('/topic/mapping', { type: 'FLOORPLAN_READY', robotId: 'orinka_01', mapId: 'raw1', imageUrl: '/api/maps/raw1/image' })
for (let i = 0; i < 20; i++) { if (!(await ev(`!!document.querySelector('.iso-stage')`))) break; await sleep(500) }
console.log('  압출 씬 :', await ev(`!!document.querySelector('.iso-stage')`))
console.log('  → RAW 는 압출하지 않는다 :', ok(!(await ev(`!!document.querySelector('.iso-stage')`))))
console.log('  → 2D 로 되돌아간다 :', ok(await ev(`!!document.querySelector('#pMap canvas')`)))

console.log('\n[6] 평면 ↔ 입체 전환')
be.setActivePlan(floorplanDetail(makeFloorplan(), 'fp3'))
be.push('/topic/mapping', { type: 'FLOORPLAN_READY', robotId: 'orinka_01', mapId: 'fp3', imageUrl: '/api/maps/fp3/image' })
for (let i = 0; i < 20; i++) { if (await ev(`!!document.querySelector('.iso-stage')`)) break; await sleep(500) }
console.log('  → 도면이 돌아오면 다시 입체 :', ok(await ev(`!!document.querySelector('.iso-stage')`)))
await ev(`[...document.querySelectorAll('.mapdim')][0]?.click()`); await sleep(700)
console.log('  → 평면으로 전환 :', ok(!(await ev(`!!document.querySelector('.iso-stage')`)) && !!(await ev(`!!document.querySelector('#pMap canvas')`))))
await ev(`[...document.querySelectorAll('.mapdim')][0]?.click()`); await sleep(700)
console.log('  → 다시 입체로 :', ok(await ev(`!!document.querySelector('.iso-stage')`)))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
