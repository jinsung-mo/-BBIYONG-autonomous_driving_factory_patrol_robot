// S15P11E101-777 검증 — 3D 뷰 2차 폴리싱
//
// 완료 기준 네 가지를 그대로 잰다.
//   1. 벽이 얇아진다
//   2. 바닥이 흰색으로 통일된다
//   3. 방향키로 지도를 옮길 수 있다
//   4. 벽과 장애물이 다른 색으로 표시된다
//
// 클래스나 선언이 아니라 '화면에 실제로 나온 값' 을 본다 — 선언은 더 구체적인
// 규칙에 밀려 적용되지 않을 수 있고, 그때도 클래스는 그대로 붙어 있다.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend, makeFloorplan, floorplanDetail } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
// 압출은 정제 도면에서만 돈다. RAW 점유격자를 활성으로 두면 3D 토글 자체가 안 나온다.
be.setActivePlan(floorplanDetail(makeFloorplan()))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9527', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9527/json/list')).json(); if (tg.length) break } catch {}
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

// 지도 탭 → 3D
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='지도')?.click()`)
await sleep(1400)
// 버튼 라벨은 '지금 무엇으로 보고 있는지' 를 말한다 — '평면' 이면 아직 2D 다.
// 무턱대고 누르면 이미 입체인 화면을 평면으로 돌려 버린다.
const stage = () => ev(`!!document.querySelector('.iso-stage')`)
if (!(await stage())) {
  await ev(`[...document.querySelectorAll('#pgMap button')].find(b=>(b.textContent||'').trim()==='평면')?.click()`)
  await sleep(2800)
}
console.log('  3D 스테이지 :', (await stage()) ? '떴다' : '없다',
  '|', await ev(`JSON.stringify([...document.querySelectorAll('#pgMap button')].map(b=>b.textContent.trim()).slice(0,8))`))

// ---------------------------------------------------------------------------
console.log('\n[1] 벽이 얇아지는가')
// 압출 소스를 같은 코드로 다시 만들어, 깎기 전/후 벽 픽셀 비율을 직접 비교한다.
// 화면 픽셀을 세면 기울기·조명 때문에 값이 흔들려 무엇 때문에 줄었는지 알 수 없다.
const thin = await ev(`(async()=>{
  const m = await import('/src/live/isoExtrude.ts')
  // 두께 6px 짜리 벽이 있는 도면을 만든다 — 실제 도면의 벽도 이 정도다
  const cv=document.createElement('canvas'); cv.width=200; cv.height=200
  const g=cv.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,200,200)
  g.fillStyle='#000'; g.fillRect(20,20,160,6); g.fillRect(20,20,6,160)
  const img=new Image()
  await new Promise(r=>{ img.onload=r; img.src=cv.toDataURL() })
  const s = await m.buildExtrudeSource(img)
  const r = { raw:s.wallRatioRaw, thin:s.wallRatio, w:s.w, h:s.h }
  m.releaseExtrudeSource(s)
  return JSON.stringify(r)})()`)
const t = JSON.parse(thin || '{}')
const shrink = t.raw ? 1 - t.thin / t.raw : 0
console.log('  벽 픽셀 비율 :', t.raw?.toFixed(4), '→', t.thin?.toFixed(4),
  `(${Math.round(shrink * 100)}% 얇아짐)`)
console.log('  → 벽이 얇아진다 :', ok(shrink > 0.2), '(20% 이상 줄어야 눈에 보인다)')
console.log('  → 벽이 사라지지는 않는다 :', ok(t.thin > 0),
  '(방이 뚫린 것으로 읽히면 두꺼운 것보다 나쁘다)')

// 얇은 벽(2px)은 통째로 사라지면 안 된다
const keepThin = await ev(`(async()=>{
  const m = await import('/src/live/isoExtrude.ts')
  const cv=document.createElement('canvas'); cv.width=200; cv.height=200
  const g=cv.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,200,200)
  g.fillStyle='#000'; g.fillRect(20,100,160,2)
  const img=new Image()
  await new Promise(r=>{ img.onload=r; img.src=cv.toDataURL() })
  const s = await m.buildExtrudeSource(img)
  const r = s.wallRatio
  m.releaseExtrudeSource(s)
  return r})()`)
console.log('  2px 벽만 있는 도면의 벽 비율 :', Number(keepThin).toFixed(5))
console.log('  → 얇은 벽은 살아남는다 :', ok(Number(keepThin) > 0),
  '(겉만 깎으면 얇은 벽은 통째로 지워진다 — 능선을 남겨야 한다)')

// ---------------------------------------------------------------------------
console.log('\n[2] 바닥이 흰색인가')
const floor = await ev(`(()=>{const f=document.querySelector('.iso-floor')
  if(!f) return null
  const cs=getComputedStyle(f)
  return JSON.stringify({bg:cs.backgroundColor, img:cs.backgroundImage, filter:cs.filter})})()`)
const fl = JSON.parse(floor || 'null') || {}
console.log('  바닥 :', floor)
const rgb = String(fl.bg || '').match(/\d+/g)?.map(Number) || []
const white = rgb.length >= 3 && rgb[0] > 245 && rgb[1] > 245 && rgb[2] > 245
console.log('  → 바닥이 흰색이다 :', ok(white))
console.log('  → 도면 그림이 깔려 있지 않다 :', ok(!!fl.bg && /^none$/.test(fl.img || '')),
  '(회색 얼룩이 기둥과 뒤섞이면 어디가 벽인지 헤맨다)')

// ---------------------------------------------------------------------------
console.log('\n[3] 방향키로 지도를 옮길 수 있는가')
const sceneT = () => ev(`(()=>{const s=document.querySelector('.iso-scene')
  return s ? getComputedStyle(s).transform : null})()`)
// 스테이지에 포커스를 준 뒤 방향키를 누른다
await ev(`document.querySelector('.iso-stage')?.focus()`)
await sleep(300)
const before = await sceneT()
const key = async (k) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k] })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k] })
  await sleep(240)
}
await key('ArrowRight'); await key('ArrowRight'); await key('ArrowDown')
await sleep(700)
const after = await sceneT()
// matrix3d 의 이동 성분(마지막 열)이 바뀌었는지 본다. transform 문자열 비교로는
// 회전이 바뀐 것인지 이동이 바뀐 것인지 가릴 수 없다.
// matrix3d 값에는 1e-05 같은 지수 표기가 섞인다 — 숫자를 통째로 잡아야 한다
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi
const offsetOf = (m) => {
  // 'matrix3d' 의 3 이 숫자로 잡히면 개수가 하나 어긋난다 — 괄호 안만 읽는다
  const n = String(m || '').replace(/^[^(]*\(|\)\s*$/g, '').match(NUM)?.map(Number) || []
  if (n.length === 16) return { x: n[12], y: n[13] }
  if (n.length === 6) return { x: n[4], y: n[5] }
  return null
}
const b = offsetOf(before)
const a = offsetOf(after)
const moved = (a && b) ? Math.hypot(a.x - b.x, a.y - b.y) : -1
console.log('  씬 이동량 :', Math.round(moved), 'px', JSON.stringify({ b, a }))
console.log('  → 방향키로 지도가 움직인다 :', ok(moved > 10))

// 돌아가는 길도 남아 있어야 한다 — 키보드만 쓰는 사람에게는 여기뿐이다
const spinBefore = await sceneT()
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 8 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 8 })
await sleep(800)
const spinAfter = await sceneT()
// 회전은 행렬 앞쪽 성분이 바뀐다. 이동만 바뀐 것과 구분한다.
const rotOf = (m) => {
  // 'matrix3d' 의 3 이 숫자로 잡히면 개수가 하나 어긋난다 — 괄호 안만 읽는다
  const n = String(m || '').replace(/^[^(]*\(|\)\s*$/g, '').match(NUM)?.map(Number) || []
  return n.length >= 6 ? n.slice(0, 6).map((v) => Math.round(v * 1000) / 1000).join(',') : ''
}
console.log('  → Shift+방향키로 여전히 돌아간다 :', ok(rotOf(spinBefore) !== rotOf(spinAfter)),
  '(748 에서 넣은 키보드 회전을 잃으면 안 된다)')

// '정면으로' 가 이동까지 되돌리는지
await ev(`document.querySelector('#pgMap .iso-reset, .iso-reset')?.click()`)
await sleep(900)
const reset = offsetOf(await sceneT())
console.log('  정면으로 누른 뒤 이동 :', JSON.stringify(reset))
console.log('  → 정면으로 가 이동도 되돌린다 :',
  ok(!!reset && Math.abs(reset.x - (b?.x ?? 0)) < 4 && Math.abs(reset.y - (b?.y ?? 0)) < 4),
  '(각도만 돌아오고 화면이 딴 데 있으면 되돌린 것이 아니다)')

// ---------------------------------------------------------------------------
console.log('\n[4] 벽과 장애물이 다른 색인가')
// BE 가 3값(0/1/2)을 내보내기 전이므로, 3값이 담긴 도면을 직접 만들어
// FE 가 그것을 소비할 수 있는지 본다. 지금 도면(순수 흑백)에서는 장애물이 0 이어야 한다.
const three = await ev(`(async()=>{
  const m = await import('/src/live/isoExtrude.ts')
  const cv=document.createElement('canvas'); cv.width=200; cv.height=200
  const g=cv.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,200,200)
  g.fillStyle='#000'; g.fillRect(20,20,160,6)          // 벽
  g.fillStyle='#808080'; g.fillRect(60,80,30,30)       // 장애물(중간 회색)
  const img=new Image()
  await new Promise(r=>{ img.onload=r; img.src=cv.toDataURL() })
  const s = await m.buildExtrudeSource(img)
  const r = { wall:s.wallRatio, obst:s.obstacleRatio, hasUrl:!!s.obstacleUrl }
  m.releaseExtrudeSource(s)
  return JSON.stringify(r)})()`)
const th = JSON.parse(three || '{}')
console.log('  3값 도면 :', three)
console.log('  → 장애물을 벽과 따로 골라낸다 :', ok(th.obst > 0 && th.wall > 0))
console.log('  → 장애물 마스크가 만들어진다 :', ok(th.hasUrl === true))

const bw = await ev(`(async()=>{
  const m = await import('/src/live/isoExtrude.ts')
  const cv=document.createElement('canvas'); cv.width=120; cv.height=120
  const g=cv.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,120,120)
  g.fillStyle='#000'; g.fillRect(10,10,100,6)
  const img=new Image()
  await new Promise(r=>{ img.onload=r; img.src=cv.toDataURL() })
  const s = await m.buildExtrudeSource(img)
  const r = { obst:s.obstacleRatio, hasUrl:!!s.obstacleUrl }
  m.releaseExtrudeSource(s)
  return JSON.stringify(r)})()`)
const b2 = JSON.parse(bw || '{}')
console.log('  흑백 도면 :', bw)
console.log('  → 지금 도면에서는 장애물이 없다 :', ok(b2.obst === 0 && b2.hasUrl === false),
  '(BE 가 3값을 내보내기 전에는 화면이 지금과 같아야 한다)')

// 색이 실제로 다른가 — 벽 층과 장애물 층의 렌더된 배경색을 비교한다
const colors = await ev(`(()=>{
  const wall=document.querySelector('.iso-wall:not(.iso-obst)')
  const obst=document.querySelector('.iso-obst')
  const c=(el)=>el?getComputedStyle(el).backgroundColor:null
  return JSON.stringify({wall:c(wall), obst:c(obst)})})()`)
console.log('  층 색(지금 도면) :', colors)

// 3값 도면을 활성으로 바꿔, 장애물 층이 실제로 다른 색으로 렌더되는지 본다.
// 여기까지 봐야 '구분된다' 를 말할 수 있다 — 마스크만 만들어지고 화면에 안 나올 수 있다.
be.setActivePlan(floorplanDetail(makeFloorplan(320, 240, { obstacles: true }), 'fp2'))
be.push('/topic/mapping', { type: 'FLOORPLAN_READY', mapId: 'fp2' })
await sleep(3200)
const both = await ev(`(()=>{
  const wall=document.querySelector('.iso-wall:not(.iso-obst)')
  const obst=document.querySelector('.iso-obst')
  const c=(el)=>el?getComputedStyle(el).backgroundColor:null
  const rect=(el)=>{const r=el?el.getBoundingClientRect():null; return r?Math.round(r.width):0}
  return JSON.stringify({wall:c(wall), obst:c(obst), n:document.querySelectorAll('.iso-obst').length,
    wallW:rect(wall), obstW:rect(obst)})})()`)
const bo = JSON.parse(both || '{}')
console.log('  3값 도면 적용 후 :', both)
const parse = (c) => (String(c || '').match(/\d+/g) || []).map(Number)
const wc = parse(bo.wall), oc = parse(bo.obst)
const diff = (wc.length >= 3 && oc.length >= 3)
  ? Math.abs(wc[0] - oc[0]) + Math.abs(wc[1] - oc[1]) + Math.abs(wc[2] - oc[2]) : 0
console.log('  두 색의 차이 :', diff)
console.log('  → 장애물 층이 화면에 나온다 :', ok(bo.n > 0 && bo.obstW > 0))
console.log('  → 벽과 다른 색으로 보인다 :', ok(diff > 60),
  '(벽은 못 치우고 장애물은 치울 수 있다 — 같은 색이면 그 구분이 사라진다)')
console.log('  → 장애물이 벽보다 낮다 :', ok(bo.n > 0 && bo.n < 40),
  '(벽과 같은 높이면 무엇이 건물인지 알 수 없다)')
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'E777-iso.png', Buffer.from(data, 'base64'))
}

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
