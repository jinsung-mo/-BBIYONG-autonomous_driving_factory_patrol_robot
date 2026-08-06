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
  '--remote-debugging-port=9505', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9505/json/list')).json(); if (tg.length) break } catch {}
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
// S15P11E101-750 검증 — 차량형 3D 로봇 마커
//
// '입체로 보인다' 는 눈의 말이지만 근거는 구조에 있다 — 판이 여러 장 쌓여 있고,
// 각 판이 서로 다른 z 에 있으며, 차체가 yaw 로 돌고, 위로 갈수록 밝다.
const pose = (x, y, yaw = 0) => be.push('/topic/nav/orinka_01', { type: 'NAV_LIVE', pose: { x, y, yaw } })
const car = () => ev(`(()=>{const e=document.querySelector('.iso-robot'); if(!e) return null
  const px=(v)=>Math.round(parseFloat(v)||0)
  const lum=(c)=>{const p=c.slice(c.indexOf('(')+1,c.indexOf(')')).split(',').map(Number)
    return Math.round((0.2126*p[0]+0.7152*p[1]+0.0722*p[2])/255*100)}
  const plates=[...e.querySelectorAll('.iso-car-plate')]
  const zOf=(el)=>{const m=new DOMMatrix(getComputedStyle(el).transform); return Math.round(m.m43)}
  const body=e.querySelector('.iso-car')
  return {
    plates: plates.length,
    zSpread: plates.length ? zOf(plates[plates.length-1]) - zOf(plates[0]) : 0,
    lumLow: plates.length ? lum(getComputedStyle(plates[0]).backgroundColor) : null,
    lumHigh: plates.length ? lum(getComputedStyle(plates[plates.length-1]).backgroundColor) : null,
    roofZ: (()=>{const r=e.querySelector('.iso-car-roof'); return r?zOf(r):null})(),
    lightZ: (()=>{const l=e.querySelector('.iso-car-light'); return l?zOf(l):null})(),
    shadow: !!e.querySelector('.iso-car-shadow'),
    bodyT: body?getComputedStyle(body).transform:null,
    preserve: body?getComputedStyle(body).transformStyle:null,
    off: e.classList.contains('off'),
    left: parseFloat(e.style.left), top: parseFloat(e.style.top),
  }})()`)

await goTab('지도')
pose(3.0, 4.2, 0)
await sleep(2200)
let c = await car()
console.log('  DBG :', await ev(`(()=>{const e=document.querySelector('.iso-robot')
  const st=document.querySelector('.iso-stage')
  const r=e.getBoundingClientRect(), sr=st.getBoundingClientRect()
  const p=e.querySelector('.iso-car-plate')
  const pr=p?p.getBoundingClientRect():null
  return JSON.stringify({disp:getComputedStyle(e).display,
    robot:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
    plate:pr?[Math.round(pr.left),Math.round(pr.top),Math.round(pr.width),Math.round(pr.height)]:null,
    stage:[Math.round(sr.left),Math.round(sr.top),Math.round(sr.width),Math.round(sr.height)]})})()`))

console.log('\n[1] 평면 원이 아니라 부피가 있는가')
console.log('  판 :', c?.plates, '장 · z 범위', c?.zSpread + 'px · 지붕 z', c?.roofZ, '· 앞등 z', c?.lightZ)
console.log('  → 판이 여러 장 쌓여 있다 :', ok((c?.plates ?? 0) >= 8), '(한 장이면 여전히 납작하다)')
console.log('  → 서로 다른 높이에 있다 :', ok((c?.zSpread ?? 0) >= 8))
console.log('  → 지붕이 차체 위에 얹힌다 :', ok((c?.roofZ ?? 0) > (c?.zSpread ?? 0) - 1))
console.log('  → 3D 로 합성된다 :', ok(c?.preserve === 'preserve-3d'), '(flat 이면 판이 겹쳐 한 장으로 보인다)')
console.log('  음영 :', c?.lumLow + '%', '→', c?.lumHigh + '%', '· 폭', Math.abs((c?.lumHigh ?? 0) - (c?.lumLow ?? 0)) + '%')
console.log('  → 위로 갈수록 밝다 :', ok((c?.lumHigh ?? 0) > (c?.lumLow ?? 0)))
console.log('  → 폭이 과하지 않다 :', ok(Math.abs((c?.lumHigh ?? 0) - (c?.lumLow ?? 0)) <= 22), '(748 의 벽 규칙과 같은 폭)')

console.log('\n[2] 바닥에 얹혀 있는가')
console.log('  → 접지 그림자가 있다 :', ok(c?.shadow), '(없으면 공중에 뜬 것처럼 보인다)')
// 처음에는 '바닥에 얹힌다' 를 문자 그대로 z=2 로 내렸다가, 실제로 띄워 보니 벽 층에
// 묻혀 아무것도 안 보였다 — 745 가 띄운 이유가 그것이었다.
// 그러니 잴 것은 '낮다' 가 아니라 '보이면서도 접지감이 있다' 다.
console.log('  → 벽에 묻히지 않는다 :', ok(await ev(`(()=>{const v=parseFloat(document.querySelector('.iso-robot').style.getPropertyValue('--rz'))
  return v >= 46})()`)), '(벽 높이 약 46px 아래면 가려진다)')
console.log('  → 바닥까지 기둥이 내려온다 :', ok(await ev(`(()=>{const s=getComputedStyle(document.querySelector('.iso-robot'),'::before')
  return parseFloat(s.height) >= 46})()`)), '(어디 위에 서 있는지 알려 준다)')

console.log('\n[3] yaw 로 차체가 도는가')
const angleOf = (t) => {
  const m = String(t).match(/matrix\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(',').map(Number)
  return Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI)
}
for (const y of [0, Math.PI / 2]) {
  pose(3.0, 4.2, y); await sleep(2000)
  c = await car()
  console.log(`  pose.yaw ${y.toFixed(2)} → 차체 회전 ${angleOf(c?.bodyT)}도 (기대 ${Math.round(-y * 180 / Math.PI)}도)`,
    ok(Math.abs((angleOf(c?.bodyT) ?? 999) - Math.round(-y * 180 / Math.PI)) <= 2))
}

console.log('\n[4] 이동이 끊기지 않는가')
pose(-2.0, -1.5, 0); await sleep(2200)
const from = await car()
pose(5.0, 6.0, 0); await sleep(90)
const mid = await car()
await sleep(1800)
const to = await car()
const d = (a, b) => Math.hypot(a.left - b.left, a.top - b.top)
console.log('  출발', `(${from?.left}, ${from?.top})`, '→ 90ms', `(${mid?.left?.toFixed(1)}, ${mid?.top?.toFixed(1)})`,
  '→ 최종', `(${to?.left?.toFixed(1)}, ${to?.top?.toFixed(1)})`)
console.log('  → 중간 프레임이 있다 :', ok(d(mid, { left: 140, top: 90 }) > 1))
console.log('  → 결국 목표에 닿는다 :', ok(d(to, { left: 140, top: 90 }) < 1))

console.log('\n[5] 오프라인 상태가 드러나는가')
be.push('/topic/robots', { type: 'STATE_UPDATE', robotId: 'orinka_01', online: false })
await sleep(1400)
c = await car()
console.log('  → 흐려진다 :', ok(c?.off === true))
console.log('  → 앞등 발광이 꺼진다 :', ok(await ev(`getComputedStyle(document.querySelector('.iso-car-light')).boxShadow === 'none'`)))
be.push('/topic/robots', { type: 'STATE_UPDATE', robotId: 'orinka_01', online: true })
await sleep(1400)
console.log('  → 돌아오면 원래대로 :', ok((await car())?.off === false))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M750-car.png', Buffer.from(data, 'base64'))
}
{
  // 마커만 크게 떠 눈으로도 확인한다 — 전체 화면에서는 28px 이라 판단이 어렵다.
  const b = await ev(`(()=>{const p=document.querySelector('.iso-car-plate').getBoundingClientRect()
    return JSON.stringify({x:Math.round(p.left-60), y:Math.round(p.top-60), width:140, height:140})})()`)
  const clip = JSON.parse(b)
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 4 } })
  writeFileSync(OUT + 'M750-car-zoom.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
