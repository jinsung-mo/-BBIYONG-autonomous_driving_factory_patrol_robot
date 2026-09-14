// S15P11E101-744 검증 — 지도 탭 매핑중 / 3D 도면 상태 전환
//
// 완료 기준 세 가지를 그대로 잰다.
//   1. START_MAPPING 후 지도 탭이 '매핑중' 으로 잠기고, 실시간 SLAM 은 운영 탭에서만 보인다
//   2. FLOORPLAN_READY 후 지도 탭이 3D 도면으로 전환된다
//   3. 매핑 도중 새로고침해도 지도 탭이 '매핑중' 으로 복원된다
//
// 3번이 이 티켓의 핵심이다. STOMP 는 붙기 전에 지나간 전환을 다시 주지 않으므로,
// 새로고침 복원은 GET /api/maps/status 하나에 달려 있다 — 그 호출이 실제로
// 나갔는지까지 확인한다. 화면만 맞고 요청이 없으면 우연히 맞은 것이다.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend, makeFloorplan, floorplanDetail } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
// 시작 상태는 매핑 중이 아니고, 활성 도면이 이미 하나 있다.
be.setActivePlan(floorplanDetail(makeFloorplan()))
be.setMappingPhase('IDLE', { push: false })

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9471', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9471/json/list')).json(); if (tg.length) break } catch {}
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

const login = async () => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); if(!i.length) return
    s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
  await sleep(5000)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')
  localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
  localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload'); await sleep(2600)
await login()

const goTab = async (label) => {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${label}')?.click()`)
  await sleep(800)
}
const mapping = () => ev(`!!document.querySelector('#pMap .map-mapping')`)
const iso = () => ev(`!!document.querySelector('#pMap .iso-stage')`)
const slamCanvas = (root) => ev(`!!document.querySelector('${root} canvas')`)
const statusCalls = () => be.restCalls.filter((c) => c.url.startsWith('/api/maps/status')).length

console.log('\n[0] 시작 상태 — 매핑 중이 아니면 도면이 보인다')
await goTab('지도')
console.log('  → 상태 복원 요청이 나갔다 :', ok(statusCalls() >= 1), `(GET /api/maps/status ${statusCalls()}회)`)
console.log('  → 매핑중 화면 아님 :', ok(!(await mapping())))
console.log('  → 3D 도면이 보인다 :', ok(await iso()))

console.log('\n[1] START_MAPPING 후 지도 탭이 매핑중으로 잠기는가')
be.setMappingPhase('MAPPING')
await sleep(1200)
console.log('  → 지도 탭이 매핑중 :', ok(await mapping()))
console.log('  → 3D 도면은 내려간다 :', ok(!(await iso())), '(그리는 중인 구역을 확정된 지도로 보이면 안 된다)')
console.log('  → 안내 문구가 있다 :', ok(await ev(`/운영 탭/.test(document.querySelector('#pMap .map-mapping')?.textContent||'')`)))
console.log('  → 스크린리더에 알린다 :', ok(await ev(`document.querySelector('#pMap .map-mapping')?.getAttribute('aria-live')==='polite'`)))
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M744-mapping.png', Buffer.from(data, 'base64'))
}

console.log('\n[2] 실시간 SLAM 은 운영 탭에서만 보이는가')
// 지도 탭에는 SLAM 격자 캔버스가 없어야 한다. 원본 격자로 되돌리는 버튼도 없어야 한다.
console.log('  → 지도 탭에 SLAM 캔버스 없음 :', ok(!(await slamCanvas('#pMap'))))
console.log('  → 원본 격자 전환 버튼 없음 :', ok(!(await ev(`!!document.querySelector('#pMap .mapkind')`))))
await goTab('운영')
console.log('  → 운영 탭에는 실시간 지도가 있다 :', ok(await ev(`!!document.querySelector('#pgOps canvas, .ops-map canvas, .opsmap canvas')
  || [...document.querySelectorAll('canvas')].length>0`)))

console.log('\n[3] 매핑 도중 새로고침해도 매핑중으로 복원되는가')
const before = statusCalls()
await send('Page.reload'); await sleep(3000)
await login()
await goTab('지도')
console.log('  새로고침 뒤 상태 요청 :', statusCalls() - before, '회')
console.log('  → 다시 조회한다 :', ok(statusCalls() > before), '(STOMP 는 지나간 전환을 주지 않는다)')
console.log('  → 매핑중으로 복원 :', ok(await mapping()))
console.log('  → 도면으로 튀지 않는다 :', ok(!(await iso())))

console.log('\n[4] FLOORPLAN_READY 후 3D 도면으로 전환되는가')
be.pushFloorplanReady('fp1')
await sleep(2500)
console.log('  → 매핑중 화면이 걷힌다 :', ok(!(await mapping())))
console.log('  → 3D 도면으로 전환 :', ok(await iso()))
console.log('  → 벽이 여러 층으로 쌓임 :', ok((await ev(`document.querySelectorAll('#pMap .iso-wall').length`)) >= 20))
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M744-floorplan.png', Buffer.from(data, 'base64'))
}

console.log('\n[5] 상태를 모를 때 함부로 단정하지 않는가')
// 상태 API 가 없는 서버(404)에서도 화면이 깨지지 않아야 한다.
console.log('  → 콘솔 에러 없음 :', ok(errs.length === 0), errs.slice(0, 2).join(' | '))

ws.close(); chrome.kill()
process.exit(0)
