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
  '--remote-debugging-port=9509', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9509/json/list')).json(); if (tg.length) break } catch {}
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

const goTab = async (label) => {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${label}')?.click()`)
  await sleep(1200)
}
// S15P11E101-759 검증 — 열화상 시계방향 90도 회전
//
// 세 가지를 잰다.
//   1. 열화상 캔버스가 시계방향 90도 돌아 있다
//   2. 회전 후 컨테이너에서 잘리거나 비율이 왜곡되지 않는다
//   3. FRONT/THERMAL 스왑 후에도 회전이 유지된다
// HUD(최고 온도)는 회전 대상이 아니다 — 글자가 누우면 읽을 수 없다.
const thermal = () => ev(`(()=>{const p=document.querySelector('#pThermal'); if(!p) return null
  const cv=p.querySelector('canvas'); const wrap=p.querySelector('.vwrap')
  const hud=p.querySelector('.hud2')
  if(!cv||!wrap) return null
  const m=new DOMMatrix(getComputedStyle(cv).transform)
  const deg=Math.round(Math.atan2(m.m12, m.m11)*180/Math.PI)
  const cr=cv.getBoundingClientRect(), wr=wrap.getBoundingClientRect()
  const cs=getComputedStyle(cv)
  return {
    deg,
    fit: cs.objectFit,
    // 회전 뒤 화면에서 차지하는 상자와 컨테이너
    canvas:[Math.round(cr.left),Math.round(cr.top),Math.round(cr.width),Math.round(cr.height)],
    wrap:[Math.round(wr.left),Math.round(wr.top),Math.round(wr.width),Math.round(wr.height)],
    // 안쪽 픽셀 비율이 유지되는가 (캔버스 고유 비율 대비)
    intrinsic:[cv.width, cv.height],
    cssSize:[Math.round(parseFloat(cs.width)), Math.round(parseFloat(cs.height))],
    // 오버레이(온도 HUD·안내 문구)는 캔버스의 형제다. 하나라도 돌아 있으면 글자가 눕는다.
    // 지금 화면에 무엇이 떠 있든 '캔버스가 아닌 것은 돌지 않는다' 를 재면 된다.
    overlays: [...wrap.children].filter(e=>e.tagName!=='CANVAS').map(e=>{
      const mm=new DOMMatrix(getComputedStyle(e).transform)
      return {cls:e.className, deg:Math.round(Math.atan2(mm.m12, mm.m11)*180/Math.PI)}}),
    pip: p.classList.contains('pip'),
  }})()`)

await goTab('카메라')
await sleep(1500)
let t = await thermal()

console.log('\n[1] 시계방향 90도로 돌아 있는가')
console.log('  회전각 :', t?.deg, '도')
console.log('  → 90도 :', ok(t?.deg === 90), '(양수가 시계방향 — 화면 y 축이 아래로 자란다)')
console.log('  오버레이 :', JSON.stringify(t?.overlays))
console.log('  → 오버레이는 정방향 :', ok((t?.overlays || []).every((o) => o.deg === 0)),
  '(글자가 누우면 읽을 수 없다)')

console.log('\n[2] 잘리거나 왜곡되지 않는가')
console.log('  캔버스 상자 :', JSON.stringify(t?.canvas), '· 컨테이너 :', JSON.stringify(t?.wrap))
const inside = t && t.canvas[0] >= t.wrap[0] - 1 && t.canvas[1] >= t.wrap[1] - 1
  && t.canvas[0] + t.canvas[2] <= t.wrap[0] + t.wrap[2] + 1
  && t.canvas[1] + t.canvas[3] <= t.wrap[1] + t.wrap[3] + 1
console.log('  → 컨테이너 안에 들어온다 :', ok(inside), '(넘치면 잘린다)')
console.log('  CSS 크기 :', JSON.stringify(t?.cssSize), '· 컨테이너 가로세로 뒤집힘 기대',
  JSON.stringify([t?.wrap[3], t?.wrap[2]]))
console.log('  → 가로·세로를 맞바꿔 잡는다 :',
  ok(Math.abs(t.cssSize[0] - t.wrap[3]) <= 2 && Math.abs(t.cssSize[1] - t.wrap[2]) <= 2))
console.log('  object-fit :', t?.fit)
console.log('  → 비율을 지킨다 :', ok(t?.fit === 'contain'), '(늘려 채우면 열원 위치가 어긋나 보인다)')

console.log('\n[3] 스왑 후에도 회전이 유지되는가')
console.log('  지금 PiP :', t?.pip)
await ev(`document.querySelector('#pThermal')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
await sleep(1000)
t = await thermal()
console.log('  스왑 후 PiP :', t?.pip, '· 회전각', t?.deg, '· 상자', JSON.stringify(t?.canvas))
console.log('  → 크게 바뀌었다 :', ok(t?.pip === false))
console.log('  → 회전은 그대로 90도 :', ok(t?.deg === 90))
const inside2 = t && t.canvas[0] >= t.wrap[0] - 1 && t.canvas[1] >= t.wrap[1] - 1
  && t.canvas[0] + t.canvas[2] <= t.wrap[0] + t.wrap[2] + 1
  && t.canvas[1] + t.canvas[3] <= t.wrap[1] + t.wrap[3] + 1
console.log('  → 커진 뒤에도 잘리지 않는다 :', ok(inside2))
console.log('  → 오버레이는 여전히 정방향 :', ok((t?.overlays || []).every((o) => o.deg === 0)))

{
  const b = await ev(`(()=>{const w=document.querySelector('#pThermal .vwrap').getBoundingClientRect()
    return JSON.stringify({x:Math.round(w.left), y:Math.round(w.top), width:Math.round(w.width), height:Math.round(w.height)})})()`)
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...JSON.parse(b), scale: 1 } })
  writeFileSync(OUT + 'M759-thermal.png', Buffer.from(data, 'base64'))
}
// 되돌려 둔다
await ev(`document.querySelector('#pCam')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
await sleep(800)
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
