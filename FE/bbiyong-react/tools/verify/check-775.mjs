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
  '--remote-debugging-port=9537', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9537/json/list')).json(); if (tg.length) break } catch {}
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
  await sleep(1400)
}
// S15P11E101-775 검증 — 순찰경로 라이브 맵 팔로우 카메라
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 매핑 내내 로봇이 화면 중앙 부근에 유지된다
//   2. 수동 개입과 복귀가 자연스럽다
//
// '중앙에 있다' 는 로봇이 그려진 픽셀의 무게중심과 캔버스 중심의 거리로 잰다.
//
// 아직 미완성이다. 이 하네스에서 운영 탭 라이브 맵에 격자·로봇이 그려지지 않아
// (painted 110 / green 0) 중앙 판정을 할 수 없다. check-763 은 같은 캔버스에서
// 픽셀을 찾으므로 하네스 설정 차이로 보이지만 아직 못 좁혔다.
// [4] 의 개입·복귀(버튼 등장·소멸)는 실제로 확인된다.
let seq = 0
const pushMap = (cols, rows) => be.push('/topic/nav/orinka_01', {
  // decodeMapSnapshot 계약: w/h/res/ox/oy + cells 는 [값, 반복]이 번갈아 든 평탄 배열이다.
  // 예전에는 cols/rows/rle 로 보내 앱이 통째로 버렸다 — 검사가 나침반 픽셀만 세고 통과했다.
  type: 'MAP', sequence: ++seq, w: cols, h: rows, res: 0.05, ox: -2.0, oy: -1.5,
  cells: [0, Math.floor(cols * rows / 2), 100, cols * rows - Math.floor(cols * rows / 2)],
})
const pose = (x, y) => be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x, y, yaw: 0 } })
// 로봇 화면 좌표 = view.x + x*s, view.y - y*s. 뷰 상태를 못 읽으니 캔버스에서 되짚는다.
const offCenter = (wx, wy) => ev(`(async()=>{const m=await import('/src/live/navMap.ts')
  const cv=document.querySelector('#pgOps .routemap canvas'); if(!cv) return null
  // 화면 중심의 월드 좌표를 구해 로봇 좌표와의 거리를 잰다
  const w=m.canvasToWorld({x:0,y:0,s:1,init:true}, null, false, 0, 0, cv)
  return null})()`)
const robotScreen = () => ev(`(()=>{const cv=document.querySelector('#pgOps .routemap canvas')
  if(!cv) return null
  const g=cv.getContext('2d'); const d=g.getImageData(0,0,cv.width,cv.height).data
  // 로봇 마커는 호박색(#f0c98a)이다. 초록(#3ddc97)은 웨이포인트라 헷갈리면 안 된다.
  let sx=0, sy=0, n=0
  for(let y=0;y<cv.height;y+=2){ for(let x=0;x<cv.width;x+=2){
    const i=(y*cv.width+x)*4
    if(d[i]>200 && d[i+1]>170 && d[i+2]<190 && d[i]-d[i+2]>50){ sx+=x; sy+=y; n++ }
  }}
  if(!n) return null
  return {x:Math.round(sx/n), y:Math.round(sy/n), w:cv.width, h:cv.height, n}})()`)
const followBtn = () => ev(`!!document.querySelector('#btnFollowRobot')`)

await goTab('운영')
be.setMappingPhase('MAPPING')
await sleep(1600)
pushMap(200, 150)
// 로봇은 자세를 3Hz 로 계속 보낸다. 추적은 한 번에 순간이동하지 않고 부드럽게 따라가므로
// 한 번만 보내고 재면 '아직 가는 중' 을 잡게 된다 — 실제와 같이 연속으로 보낸다.
for (let i = 0; i < 8; i++) { pose(3.0, 4.2); await sleep(330) }
await sleep(700)

console.log('\n[1] 매핑 중 로봇이 화면 가운데 오는가')
let r = await robotScreen()
const dist = (p) => p ? Math.hypot(p.x - p.w/2, p.y - p.h/2) : null
console.log('  로봇 화면 :', JSON.stringify(r), '· 중심에서', dist(r)?.toFixed(0) + 'px')
console.log('  → 중앙 부근에 있다 :', ok(r && dist(r) < Math.min(r.w, r.h) * 0.2), '(짧은 변의 20% 안)')

console.log('\n[2] 로봇이 움직여도 따라가는가')
for (const [x, y] of [[5.0, 6.0], [7.0, 8.0], [9.0, 9.0]]) { pose(x, y); await sleep(700) }
// 같은 자리를 몇 번 더 보내 추적이 수렴하게 둔다. 궤적은 지난 자리를 남기므로
// 움직이는 도중에 재면 무게중심이 뒤로 끌린다.
for (let i = 0; i < 9; i++) { pose(9.0, 9.0); await sleep(320) }
await sleep(800)
r = await robotScreen()
console.log('  이동 후 :', JSON.stringify(r), '· 중심에서', dist(r)?.toFixed(0) + 'px')
console.log('  → 여전히 중앙 부근 :', ok(r && dist(r) < Math.min(r.w, r.h) * 0.2))

console.log('\n[3] 지도가 넓어져도 중앙을 지키는가')
pushMap(600, 450)
for (let i = 0; i < 4; i++) { pose(9.0, 9.0); await sleep(350) }
await sleep(900)
r = await robotScreen()
console.log('  확장 후 :', JSON.stringify(r), '· 중심에서', dist(r)?.toFixed(0) + 'px')
console.log('  → refit 뒤에도 중앙 :', ok(r && dist(r) < Math.min(r.w, r.h) * 0.2),
  '(refit 만 하면 새로 발견한 쪽으로 화면이 끌려간다)')

console.log('\n[4] 드래그로 개입하면 멈추고, 버튼으로 돌아오는가')
console.log('  → 따라가는 동안엔 버튼이 없다 :', ok((await followBtn()) === false))
const box = await ev(`(()=>{const c=document.querySelector('#pgOps .routemap canvas').getBoundingClientRect()
  return JSON.stringify({x:Math.round(c.left+c.width/2), y:Math.round(c.top+c.height/2)})})()`)
const c = JSON.parse(box)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x - 160, y: c.y - 90, button: 'left' })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x - 160, y: c.y - 90, button: 'left', clickCount: 1 })
await sleep(900)
console.log('  → 개입하면 버튼이 나온다 :', ok((await followBtn()) === true))
pose(9.0, 9.0); await sleep(1200)
r = await robotScreen()
console.log('  개입 뒤 :', JSON.stringify(r), '· 중심에서', dist(r)?.toFixed(0) + 'px')
console.log('  → 화면이 끌려가지 않는다 :', ok(r === null || dist(r) > 40), '(보려는 곳을 보게 둔다)')
await ev(`document.querySelector('#btnFollowRobot')?.click()`)
await sleep(400)
for (let i = 0; i < 5; i++) { pose(9.0, 9.0); await sleep(300) }
await sleep(800)
r = await robotScreen()
console.log('  복귀 후 :', JSON.stringify(r), '· 중심에서', dist(r)?.toFixed(0) + 'px')
console.log('  → 버튼으로 돌아온다 :', ok(r && dist(r) < Math.min(r.w, r.h) * 0.2))
console.log('  → 버튼이 사라진다 :', ok((await followBtn()) === false))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'F775-follow.png', Buffer.from(data, 'base64'))
}
console.log('\n[5] 프레임을 믿을 수 없는 자세는 따라가지 않는가 (S15P11E101-773 과의 합의)')
// odom 프레임 자세는 map 좌표가 아니다. 그 값으로 화면을 끌면 지도가 엉뚱한 곳으로
// 밀려나고, 조작자는 그 사실조차 모른다 — 가만히 있는 편이 낫다.
await ev(`document.querySelector('#btnFollowRobot')?.click()`)
for (let i = 0; i < 5; i++) { pose(9.0, 9.0); await sleep(300) }
await sleep(600)
const before = await robotScreen()
for (let i = 0; i < 6; i++) {
  be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { frame: 'odom', x: 30.0, y: 25.0, yaw: 0 } })
  await sleep(320)
}
await sleep(700)
const after = await robotScreen()
const moved = (before && after) ? Math.hypot(after.x - before.x, after.y - before.y) : -1
console.log('  odom 자세 6회 후 화면 이동 :', Math.round(moved), 'px')
console.log('  → 화면이 끌려가지 않는다 :', ok(moved >= 0 && moved < 25),
  '(틀린 위치로 지도를 옮기느니 가만히 두는 편이 낫다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)