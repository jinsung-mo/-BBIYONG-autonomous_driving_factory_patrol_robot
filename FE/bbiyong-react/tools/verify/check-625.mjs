// S15P11E101-625 검증 — 경로 적용 / 순찰 시작 분리 · PatrolStartResult 안내 · 활성 맵 교체 후 재시작
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
be.setActivateImplemented(true)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9381', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9381/json/list')).json(); if (tg.length) break } catch {}
  await sleep(500)
}
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value ?? '').join(' '))
}
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pending.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const msg = () => ev(`document.querySelector('#pgRoute .form-msg')?.textContent?.trim() || '(없음)'`)
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.click()`)
const posts = (path) => be.restCalls.filter((c) => c.method === 'POST' && (c.url || '').startsWith(path))

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password');
  document.querySelector('.auth-submit').click()})()`)
await sleep(3600)
await ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`); await sleep(2200)

console.log('\n[1] 버튼이 분리돼 있는가')
const btns = await ev(`[...document.querySelectorAll('#pgRoute .gotor button')].map(b=>b.textContent.trim()+(b.disabled?'(잠김)':''))`)
console.log('  버튼 :', (btns || []).join(' · '))
console.log('  → 경로 적용 있음 :', ok((btns || []).some((b) => b.startsWith('경로 적용'))))
console.log('  → 순찰 시작 있음 :', ok((btns || []).some((b) => b.startsWith('순찰 시작'))))
console.log('  안내 :', await ev(`document.querySelector('#pgRoute .cfg-help')?.textContent?.replace(/\\s+/g,' ').trim()`))

console.log('\n[2] 경로가 없으면 NO_ROUTE 안내')
// 지점이 없는 상태에서 시작 — 버튼이 잠겨 있으면 잠금 자체가 1차 방어다
const startDisabled = await ev(`document.querySelector('#btnStartPatrol')?.disabled`)
console.log('  경로 0개일 때 버튼 :', startDisabled ? '잠김' : '눌림 가능')
if (startDisabled) {
  // 서버 응답 경로도 직접 확인한다 — 로봇 스케줄러 등 다른 경로로도 불릴 수 있다
  const r = await ev(`(async()=>{const {startPatrol}=await import('/src/live/waypoints.ts')
    const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
    return await startPatrol(tok,'orinka_01')})()`)
  console.log('  직접 호출 결과 :', JSON.stringify(r))
  console.log('  → NO_ROUTE :', ok(r?.status === 'NO_ROUTE' && r?.patrolStarted === false))
}

console.log('\n[3] 지점을 찍고 저장 → 순찰 시작')
// 지도 클릭 대신 서버에 지점을 넣고 목록을 다시 불러온다.
// 클릭 경로(canvasToWorld)는 SLAM 맵이 있어야 하고 그것은 check-514 의 몫이다 —
// 여기서 보려는 것은 '경로가 있을 때 적용/시작이 어떻게 동작하는가' 다.
await ev(`(async()=>{const {addWaypoint}=await import('/src/live/waypoints.ts')
  const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  await addWaypoint({x:1.2,y:0.8,name:'A'},tok)
  await addWaypoint({x:2.4,y:1.6,name:'B'},tok)})()`)
await sleep(600)
await ev(`[...document.querySelectorAll('#pgRoute .gotor button')].find(b=>b.textContent.trim()==='다시 불러오기')?.click()`)
await sleep(1600)
console.log('  지점 수 :', await ev(`document.querySelectorAll('#routeList li').length`))
const c0 = be.restCalls.length
await click('#btnStartPatrol')
await sleep(1800)
const startCalls = posts('/api/patrol-route/start')
console.log('  요청 :', startCalls[startCalls.length - 1]?.url)
console.log('  → /api/patrol-route/start 호출 :', ok(startCalls.length > 0))
console.log('  → robotId 쿼리 전달 :', ok((startCalls[startCalls.length - 1]?.url || '').includes('robotId=orinka_01')))
console.log('  안내 :', await msg())
console.log('  → 시작 안내 :', ok((await msg()).includes('순찰을 시작했습니다')))
console.log('  → 로봇 순찰 중 :', ok(be.patrolRunning()))
const { data: s1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'P625-start.png', Buffer.from(s1, 'base64'))

console.log('\n[4] 경로 적용은 순찰을 시작하지 않는다')
const c1 = be.restCalls.length
await click('#btnApplyRoute')
await sleep(1600)
const applyCalls = be.restCalls.slice(c1).filter((c) => (c.url || '').startsWith('/api/patrol-route/apply'))
console.log('  요청 :', applyCalls[0]?.url)
console.log('  → /api/patrol-route/apply 호출 :', ok(applyCalls.length > 0))
console.log('  → start 는 안 나감 :', ok(!be.restCalls.slice(c1).some((c) => (c.url || '').startsWith('/api/patrol-route/start'))))
console.log('  안내 :', await msg())
console.log('  → "시작되지 않았습니다" 명시 :', ok((await msg()).includes('시작되지 않았습니다')))

console.log('\n[5] 활성 맵을 바꾼 뒤 /start 로 다시 시작하면 세션이 맞는가')
await ev(`(async()=>{const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  await fetch('http://127.0.0.1:8099/api/maps/m-new/active',{method:'PUT',headers:{Authorization:'Bearer '+tok}})})()`)
await sleep(700)
console.log('  활성 맵 세션 :', be.activeMapSession(), '· 경로 세션 유효 :', be.routeSessionValid(), '(false 여야 한다)')
console.log('  → 이전 경로 무효화됨 :', ok(!be.routeSessionValid()))
await click('#btnStartPatrol')
await sleep(1800)
console.log('  안내 :', await msg())
console.log('  → 재시작 성공 :', ok((await msg()).includes('순찰을 시작했습니다')))
console.log('  → 세션 회복 :', ok(be.routeSessionValid()), '(거절 없이 정상 순찰)')

console.log('\n[6] 로봇이 꺼져 있으면 무엇이 안 됐는지 구분해 알리는가')
be.setRobotOnline(false)
await sleep(1200)
await click('#btnStartPatrol')
await sleep(1800)
console.log('  안내 :', await msg())
console.log('  → 미전달 안내 :', ok((await msg()).includes('연결되지 않아')))
be.setRobotOnline(true)

console.log('\n[7] /apply 뒤에 STOMP SET_MODE autonomy 를 따로 보내지 않는가')
const modeFrames = be.sends.filter((s) => s.destination === '/app/control/mode')
  .map((s) => JSON.parse(s.body)).filter((b) => b.command === 'SET_MODE' && b.mode === 'autonomy')
console.log('  순찰 화면에서 나간 SET_MODE autonomy :', modeFrames.length, '건')
console.log('  → 없음 :', ok(modeFrames.length === 0), '(있으면 활성 맵 변경 시 거절된다)')

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
