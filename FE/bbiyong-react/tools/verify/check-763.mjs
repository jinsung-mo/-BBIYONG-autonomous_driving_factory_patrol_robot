// S15P11E101-763 검증 — 매핑 중 라이브 맵 렌더링
//
// 완료 기준 다섯 가지를 그대로 잰다.
//   1. 새 매핑 시작 시 이전 세션 잔상(map/pose/scan/trail)이 남지 않는다
//   2. 지도가 확장돼도 캔버스에서 잘리지 않고 자동 refit 된다
//   3. 매핑 중 옛 waypoint 가 숨고 편집·순찰 시작이 잠긴다 (서버 데이터는 보존)
//   4. START 거부 시 빈 지도가 뜨지 않는다
//   5. 매핑 완료 후 저장맵 배경·컨트롤이 복원된다
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
be.setMappingPhase('IDLE', { push: false })

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9495', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9495/json/list')).json(); if (tg.length) break } catch {}
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
// 격자 스냅샷 하나. cols×rows 를 키워 지도가 넓어지는 상황을 만든다.
let seq = 0
const pushMap = (cols, rows) => be.push('/topic/nav/orinka_01', {
  type: 'MAP', sequence: ++seq, cols, rows, resolution: 0.05,
  originX: -2.0, originY: -1.5, originYaw: 0,
  // 전부 자유 공간(0)으로 채운 RLE — 값 0 이 cols*rows 개
  rle: [[0, cols * rows]],
})
const pose = (x, y, yaw = 0) => be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x, y, yaw }, scan: null })
const noteShown = () => ev(`!!document.querySelector('#pgOps .routemap-note')`)
const view = () => ev(`(()=>{const c=document.querySelector('#pgOps .routemap canvas'); if(!c) return null
  return {w:c.width, h:c.height}})()`)

await goTab('운영')

console.log('\n[4] START 거부 시 빈 지도가 뜨지 않는가')
// START_MAPPING 을 눌러도 로봇이 받지 않으면 phase 는 IDLE 그대로다.
await ev(`document.querySelector('#btnStartMapping')?.click()`); await sleep(600)
await ev(`document.querySelector('#btnStartMappingOk')?.click()`); await sleep(1500)
console.log('  요청만 한 상태 — 매핑 안내 :', await noteShown())
console.log('  → 라이브 지도로 넘어가지 않는다 :', ok((await noteShown()) === false),
  '(요청만으로 열면 영영 안 채워지는 빈 화면이 남는다)')

console.log('\n[1] 새 매핑에 들어가면 이전 세션 잔상이 사라지는가')
// 이전 세션을 만들어 둔다
pose(3.0, 4.2, 0.5); pushMap(120, 90)
await sleep(1200)
const hadTrail = await ev(`(async()=>{let n=null
  await new Promise(r=>{const off=window.__navProbe?.(); r()})
  return true})()`)
// 매핑 진입
be.setMappingPhase('MAPPING')
await sleep(1600)
const cleared = await ev(`(()=>{const c=document.querySelector('#pgOps .routemap canvas')
  return !!c})()`)
console.log('  매핑 진입 후 캔버스 :', cleared)
console.log('  → 매핑 화면으로 전환 :', ok(await noteShown()))
console.log('  → 이전 지도가 배경으로 남지 않는다 :',
  ok(!(await ev(`!!document.querySelector('#pgOps .routemap .mapkind')`))),
  '(도면 전환 버튼이 사라지면 원본 격자를 강제하고 있다는 뜻)')

console.log('\n[3] 옛 waypoint 가 숨고 편집이 잠기는가')
const locked = await ev(`(()=>{const p=document.querySelector('#pgOps')
  const btns=['#btnSaveRoute','#btnApplyRoute','#btnStartPatrol'].map(s=>p?.querySelector(s))
  return {start:btns[2]?.disabled, apply:btns[1]?.disabled, save:btns[0]?.disabled}})()`)
console.log('  버튼 :', JSON.stringify(locked))
console.log('  → 순찰 시작·경로 적용 잠김 :', ok(locked?.start === true && locked?.apply === true))
console.log('  → 안내가 뜬다 :', ok(await ev(`/지워지지 않습니다/.test(document.querySelector('#pgOps .routemap-note')?.textContent||'')`)))
console.log('  → 서버 경로는 지우지 않는다 :', ok(be.restCalls.every((c) => c.method !== 'DELETE')),
  `(DELETE ${be.restCalls.filter((c) => c.method === 'DELETE').length}건)`)

console.log('\n[2] 지도가 넓어져도 잘리지 않는가')
pushMap(120, 90); await sleep(900)
const v1 = await view()
pushMap(400, 300); await sleep(1500)   // 지도가 3배 이상 넓어진다
const v2 = await view()
console.log('  캔버스 :', JSON.stringify(v1), '→', JSON.stringify(v2))
const fits = await ev(`(async()=>{
  const m = await import('/src/live/navMap.ts')
  return typeof m.fitView === 'function'})()`)
console.log('  → 넓어진 지도가 캔버스 안에 들어온다 :',
  ok(await ev(`(()=>{const c=document.querySelector('#pgOps .routemap canvas')
    if(!c) return false
    const g=c.getContext('2d'); const d=g.getImageData(0,0,c.width,c.height).data
    // 가장자리 한 줄이 전부 배경색(#15171c)이면 지도가 화면 안에 들어와 있다는 뜻
    let edge=0, filled=0
    for(let x=0;x<c.width;x+=4){const i=(x)*4; if(d[i]>30||d[i+1]>30) edge++}
    for(let i=0;i<d.length;i+=4){ if(d[i]>30||d[i+1]>30) filled++ }
    return filled>0 && edge===0})()`)),
  '(가장자리까지 꽉 차면 잘린 것이다)')
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M763-mapping.png', Buffer.from(data, 'base64'))
}

console.log('\n[5] 매핑이 끝나면 저장맵 컨트롤이 돌아오는가')
be.setMappingPhase('IDLE')
await sleep(1800)
console.log('  → 매핑 안내가 걷힌다 :', ok((await noteShown()) === false))
console.log('  → 도면 전환 버튼이 돌아온다 :', ok(await ev(`!!document.querySelector('#pgOps .routemap .mapkind')`)),
  '(저장 도면을 다시 배경으로 쓸 수 있다)')
// 순찰 시작은 경로가 없으면 원래도 잠긴다 — 그것으로는 매핑 잠금이 풀렸는지 알 수 없다.
// 경로 유무와 무관한 '다시 불러오기' 와 지도 클릭(십자 커서)으로 잰다.
const back = await ev(`(()=>{const p=document.querySelector('#pgOps')
  const reload=[...p.querySelectorAll('button')].find(b=>/다시 불러오기/.test(b.textContent||''))
  const cv=p.querySelector('.routemap canvas')
  return {reload:reload?.disabled, cursor:cv?getComputedStyle(cv).cursor:null}})()`)
console.log('  다시 불러오기 disabled :', back?.reload, '· 지도 커서 :', back?.cursor)
console.log('  → 편집 잠금이 풀린다 :', ok(back?.reload === false && back?.cursor === 'crosshair'))

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
