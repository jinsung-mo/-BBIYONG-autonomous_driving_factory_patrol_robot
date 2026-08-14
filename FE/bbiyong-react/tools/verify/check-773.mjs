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
  '--remote-debugging-port=9533', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9533/json/list')).json(); if (tg.length) break } catch {}
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
// S15P11E101-773 검증 — 미로컬라이즈 시 마커 숨김
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 미로컬라이즈 상태에서 마커가 그려지지 않고 '위치 확인 중' 안내가 보인다
//   2. 로컬라이즈 회복 시 마커가 올바른 위치에 다시 표시된다
//
// 틀린 위치를 자신 있게 그리는 것이 최악이라, '안 그린다' 를 값으로 확인한다.
const tele = (frame, x = 3.0, y = 4.2) => be.push('/topic/robots', {
  type: 'TELEMETRY', robotId: 'orinka_01', online: true, status: 'PATROL', battery: 80,
  location: frame === null ? { x, y, yaw: 0 } : { x, y, yaw: 0, frame },
})
const navPose = (x, y) => be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x, y, yaw: 0 } })
const view = () => ev(`(()=>{const m=document.querySelector('#pgMap .iso-robot')
  const w=document.querySelector('#pgMap .loc-wait')
  const kv=[...document.querySelectorAll('#pgMap #pStatus .kv')]
    .find(k=>/위치/.test(k.querySelector('span')?.textContent||''))
  return {marker:m?getComputedStyle(m).display:null,
    wait:!!w, waitText:(w?.textContent||'').trim().slice(0,20),
    loc:(kv?.querySelector('b')?.textContent||'').trim(),
    left:m?m.style.left:null}})()`)

await goTab('지도')

console.log('\n[1] map 프레임이면 평소대로 그리는가')
tele('map'); navPose(3.0, 4.2)
await sleep(2400)
let v = await view()
console.log('  ', JSON.stringify(v))
console.log('  → 마커가 보인다 :', ok(v?.marker !== 'none'))
console.log('  → 안내는 없다 :', ok(v?.wait === false))

console.log('\n[2] odom 폴백이면 그리지 않는가')
tele('odom')
await sleep(1800)
v = await view()
console.log('  ', JSON.stringify(v))
console.log('  → 마커를 지운다 :', ok(v?.marker === 'none'), '(흐리게 두면 흐린 마커도 저기 있다 로 읽힌다)')
console.log('  → 위치 확인 중 안내 :', ok(v?.wait === true), v?.waitText)
console.log('  → 상태 패널도 자리를 말하지 않는다 :', ok(/위치 확인 중/.test(String(v?.loc))))

console.log('\n[3] 회복되면 다시 그리는가')
tele('map'); navPose(5.0, 6.0)
await sleep(2600)
v = await view()
console.log('  ', JSON.stringify(v))
console.log('  → 마커가 돌아온다 :', ok(v?.marker !== 'none'))
console.log('  → 올바른 자리 :', ok(Math.abs(parseFloat(String(v?.left)) - 140) < 1.5), '(5.0, 6.0)m → 140px')
console.log('  → 안내가 걷힌다 :', ok(v?.wait === false))

console.log('\n[4] frame 이 없는 구버전은 기존대로인가')
tele(null); navPose(3.0, 4.2)
await sleep(2400)
v = await view()
console.log('  ', JSON.stringify(v))
console.log('  → 그대로 그린다 :', ok(v?.marker !== 'none' && v?.wait === false), '(하위호환을 깨면서까지 방어할 일은 아니다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)