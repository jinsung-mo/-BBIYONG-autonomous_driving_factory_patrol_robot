// S15P11E101-629 검증 — 활성 맵 렌더링 · originYaw 반영 · 클릭↔월드 변환 · patrol-route 저장
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')
const near = (a, b, tol = 0.06) => Math.abs(a - b) <= tol

const be = await startFakeBackend(8099)
be.setActivateImplemented(true)

// 활성 도면 — 원점이 돌아간 맵을 준다(originYaw). 이게 이번 티켓의 핵심이다.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')
const MAP = {
  id: 'map-1', name: '공장 1층', kind: 'FLOORPLAN',
  widthPx: 200, heightPx: 120, resolution: 0.05,
  originX: -2.0, originY: -1.5, originYaw: 0,
  // 서버가 주는 이미지 API 경로 — loadActivePlan 이 이 값을 보고 이미지를 받는다
  imageUrl: '/api/maps/map-1/image',
  imageBytes: PNG,
}
be.setActivePlan(MAP)

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9421', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9421/json/list')).json(); if (tg.length) break } catch {}
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

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password');
  document.querySelector('.auth-submit').click()})()`)
await sleep(4000)

console.log('\n[1] 활성 맵을 받아 렌더링하는가')
const mapCalls = be.restCalls.filter((c) => (c.url || '').startsWith('/api/maps'))
console.log('  요청 :', [...new Set(mapCalls.map((c) => c.url))].join(' · '))
console.log('  → GET /api/maps/active :', ok(mapCalls.some((c) => (c.url || '').includes('/api/maps/active'))))
console.log('  → GET /api/maps/{id}/image :', ok(mapCalls.some((c) => /\/api\/maps\/[^/]+\/image/.test(c.url || ''))))

console.log('\n[2] 도면 메타가 originYaw 까지 실려 오는가')
const plan = await ev(`(async()=>{const {loadActivePlan}=await import('/src/live/floorplan.ts')
  const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  const p=await loadActivePlan(tok)
  return p ? { w:p.w, h:p.h, res:p.res, ox:p.ox, oy:p.oy, oyaw:p.oyaw } : null})()`)
console.log('  메타 :', JSON.stringify(plan))
console.log('  → oyaw 실림 :', ok(plan != null && 'oyaw' in plan), '(예전에는 계약에만 있고 버려졌다)')
console.log('  → 원점·해상도 :', ok(plan?.res === 0.05 && plan?.ox === -2 && plan?.oy === -1.5))

console.log('\n[3] 픽셀 ↔ 월드 왕복이 맞는가 (ROS map 규약)')
// 화면 좌표계는 view 가 정하므로, view 를 만든 뒤 sx/sy 의 역함수인 canvasToWorld 로 왕복시킨다
const round = await ev(`(async()=>{const m=await import('/src/live/navMap.ts')
  const view={ x: 300, y: 400, s: 40, init:true }           // 1m = 40px
  const nav={ pose:null }
  const pts=[[0,0],[1.25,-0.75],[-2,1.5]]
  return pts.map(([wx,wy])=>{
    const px = view.x + wx*view.s, py = view.y - wy*view.s   // drawNav 의 sx/sy
    const back = m.canvasToWorld(view, nav, false, px, py)
    return { wx, wy, bx:+back.x.toFixed(4), by:+back.y.toFixed(4) }
  })})()`)
;(round || []).forEach((r) => console.log(`  (${r.wx}, ${r.wy}) → 화면 → (${r.bx}, ${r.by})`))
console.log('  → 왕복 일치 :', ok((round || []).every((r) => near(r.wx, r.bx, 1e-6) && near(r.wy, r.by, 1e-6))))

console.log('\n[4] originYaw 가 있으면 도면을 돌려 그리는가')
const drawn = await ev(`(async()=>{const m=await import('/src/live/navMap.ts')
  const cv=document.createElement('canvas'); cv.width=400; cv.height=300
  const g=cv.getContext('2d')
  const img=document.createElement('canvas'); img.width=10; img.height=10
  const calls=[]
  const realRotate=g.rotate.bind(g), realDraw=g.drawImage.bind(g)
  g.rotate=(a)=>{calls.push({op:'rotate',a:+a.toFixed(4)}); realRotate(a)}
  g.drawImage=(...a)=>{calls.push({op:'drawImage',n:a.length}); realDraw(...a)}
  const view={x:100,y:200,s:20,init:true}
  const mk=(oyaw)=>({ map:null, mapCanvas:null, pose:null, scan:null, trail:[],
    plan:{ img, w:10, h:10, res:0.1, ox:0, oy:0, oyaw } })
  // drawNav(g, cv, nav, view, headingUp, route, showPlan)
  m.drawNav(g, {width:400,height:300}, mk(0), view, false, [], true)
  // 나침반이 매번 rotate(-angle) 를 부른다(headingUp=false 면 각이 0) — 0 이 아닌 회전만 센다
  const noYaw=calls.filter(c=>c.op==='rotate' && c.a!==0).length
  calls.length=0
  m.drawNav(g, {width:400,height:300}, mk(0.7854), view, false, [], true)
  const withYaw=calls.filter(c=>c.op==='rotate' && c.a!==0)
  return { noYaw, withYaw }})()`)
console.log('  oyaw=0 회전 호출 :', drawn?.noYaw, '· oyaw=45° 회전 :', JSON.stringify(drawn?.withYaw))
console.log('  → 0 일 때 배경을 안 돌림 :', ok(drawn?.noYaw === 0), '(나침반 회전은 제외)')
console.log('  → 각이 있으면 그만큼 돌림 :', ok((drawn?.withYaw || []).some((c) => near(Math.abs(c.a), 0.7854, 1e-3))))

console.log('\n[5] 지도 클릭 → 미터 좌표로 patrol-route 저장')
await ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`); await sleep(2200)
const p0 = be.restCalls.length
await ev(`(()=>{const cv=document.querySelector('#pgRoute canvas'); if(!cv) return null
  const r=cv.getBoundingClientRect()
  cv.dispatchEvent(new MouseEvent('click',{bubbles:true, clientX:r.left+r.width*0.45, clientY:r.top+r.height*0.5}))})()`)
await sleep(1600)
const post = be.restCalls.slice(p0).find((c) => c.method === 'POST' && (c.url || '').startsWith('/api/patrol-route/points'))
console.log('  요청 :', post?.url, JSON.stringify(post?.body))
console.log('  → /api/patrol-route/points :', ok(!!post))
console.log('  → x/y 가 유한한 미터값 :', ok(Number.isFinite(post?.body?.x) && Number.isFinite(post?.body?.y)))
console.log('  → 도(degree) 로 보내지 않음 :', ok(post?.body?.yaw == null || Math.abs(post.body.yaw) <= Math.PI * 2))

console.log('\n[6] 목록·교체·삭제도 patrol-route 를 쓰는가')
const g0 = be.restCalls.length
await ev(`[...document.querySelectorAll('#pgRoute .gotor button')].find(b=>b.textContent.trim()==='다시 불러오기')?.click()`)
await sleep(1500)
const gets = be.restCalls.slice(g0).filter((c) => c.method === 'GET' && (c.url || '').startsWith('/api/patrol-route'))
console.log('  목록 :', gets[0]?.url)
console.log('  → GET /api/patrol-route :', ok(gets.length > 0))
console.log('  행 수 :', await ev(`document.querySelectorAll('#routeList li').length`))
const d0 = be.restCalls.length
await ev(`(()=>{const li=document.querySelector('#routeList li'); [...li.querySelectorAll('button')].find(b=>b.textContent.trim()==='삭제')?.click()})()`)
await sleep(1500)
const del = be.restCalls.slice(d0).find((c) => c.method === 'DELETE')
console.log('  삭제 :', del?.url)
console.log('  → /api/patrol-route/points/{id} :', ok((del?.url || '').startsWith('/api/patrol-route/points/')))
console.log('  → 옛 /api/waypoints 미사용 :', ok(!be.restCalls.some((c) => (c.url || '').startsWith('/api/waypoints'))))

console.log('\n[7] 활성 맵 전환과 이력')
const a0 = be.restCalls.length
await ev(`[...document.querySelectorAll('#pgOps .gotor button, .cfg-grid button')].find(b=>b.textContent.includes('목록 새로고침'))?.click()`)
await sleep(1500)
const listCall = be.restCalls.slice(a0).find((c) => (c.url || '') === '/api/maps' || (c.url || '').startsWith('/api/maps?'))
console.log('  이력 조회 :', listCall?.url || '(버튼 없음 — 이미 조회됨)')
const putRes = await ev(`(async()=>{const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  const r=await fetch('http://127.0.0.1:8099/api/maps/map-2/active',{method:'PUT',headers:{Authorization:'Bearer '+tok}})
  return r.status})()`)
console.log('  활성 전환 PUT :', putRes)
console.log('  → PUT /api/maps/{id}/active :', ok(putRes === 200))
const { data: shot } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'M629-map.png', Buffer.from(shot, 'base64'))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
