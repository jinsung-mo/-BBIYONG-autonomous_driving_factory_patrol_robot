// S15P11E101-628 검증 — 이벤트 상세 · 연관 영상 재생 · 상태 전이
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9411', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9411/json/list')).json(); if (tg.length) break } catch {}
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
await sleep(3600)

console.log('\n[1] 이벤트 로그 행에서 상세를 열 수 있는가')
const openable = await ev(`document.querySelectorAll('#pStatus .elog .logopen').length`)
console.log('  열 수 있는 행 :', openable, '건')
console.log('  → 이력 행이 눌린다 :', ok(openable > 0))
const c0 = be.restCalls.length
await ev(`(()=>{const li=[...document.querySelectorAll('#pStatus .elog li')].find(x=>x.textContent.includes('화재'))
  li.querySelector('.logopen').click()})()`)
await sleep(1800)
const detailCall = be.restCalls.slice(c0).find((c) => /^\/api\/events\/\d+$/.test(c.url || ''))
console.log('  상세 요청 :', detailCall?.url)
console.log('  → GET /api/events/{id} :', ok(!!detailCall))
console.log('  머리말 :', await ev(`document.querySelector('.evd-head')?.textContent?.replace(/\\s+/g,' ').trim()`))
console.log('  본문 :', await ev(`document.querySelector('.evd-meta')?.textContent?.replace(/\\s+/g,' ').trim()`))

console.log('\n[2] 연관 영상 목록과 썸네일')
const clips = await ev(`[...document.querySelectorAll('#evdClips li')].map(l=>l.textContent.replace(/\\s+/g,' ').trim())`)
console.log('  클립 :', (clips || []).join(' / '))
console.log('  → 목록 노출 :', ok((clips || []).length === 2))
const thumbLoaded = await ev(`[...document.querySelectorAll('#evdClips img')].filter(i=>i.naturalWidth>0).length`)
console.log('  썸네일 로드 :', thumbLoaded, '건')
console.log('  → 인증 붙여 받음 :', ok(thumbLoaded > 0))
console.log('  → 썸네일 요청 :', ok(be.restCalls.some((c) => (c.url || '').includes('/thumbnail'))))

console.log('\n[3] 클립 재생 — 인증 스트림을 blob 으로 물리는가')
const v0 = be.restCalls.length
await ev(`document.querySelector('#evdClips .evd-clip')?.click()`)
await sleep(2000)
const streamCall = be.restCalls.slice(v0).find((c) => (c.url || '').includes('/stream'))
console.log('  스트림 요청 :', streamCall?.url, '· partial', streamCall?.partial)
console.log('  → /api/videos/{id}/stream 호출 :', ok(!!streamCall))
const vsrc = await ev(`document.querySelector('#evdVideo')?.src?.slice(0,5)`)
console.log('  video src :', vsrc)
console.log('  → blob URL 로 물림 :', ok(vsrc === 'blob:'), '(인증 헤더를 실을 수 없어 blob 으로 받는다)')
console.log('  → 재생 요소 존재 :', ok(await ev(`!!document.querySelector('#evdVideo')`)))
const { data: shot } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'V628-detail.png', Buffer.from(shot, 'base64'))

console.log('\n[4] 상세에서 상태 전이 — 목록에도 반영되는가')
const before = await ev(`document.querySelector('.evd-head .tag.open, .evd-head .tag.done')?.textContent?.trim()`)
const p0 = be.restCalls.length
await ev(`document.querySelector('#btnEvdStatus')?.click()`)
await sleep(1800)
const patch = be.restCalls.slice(p0).find((c) => c.method === 'PATCH')
console.log('  요청 :', patch?.url, JSON.stringify(patch?.body))
console.log('  → PATCH status :', ok(patch?.body?.status === 'RESOLVED'))
console.log('  상태 :', before, '→', await ev(`document.querySelector('.evd-head .tag.open, .evd-head .tag.done')?.textContent?.trim()`))
console.log('  안내 :', await ev(`document.querySelector('#evdMsg')?.textContent`))
console.log('  → 상세에 반영 :', ok((await ev(`!!document.querySelector('.evd-head .tag.done')`))))
await ev(`[...document.querySelectorAll('.modal button, [role=dialog] button')].find(b=>b.textContent.trim()==='닫기')?.click()`)
await sleep(900)
const rowTag = await ev(`(()=>{const li=[...document.querySelectorAll('#pStatus .elog li')].find(x=>x.textContent.includes('화재'))
  return [...li.querySelectorAll('.tag')].map(t=>t.className+':'+t.textContent).join(' ')})()`)
console.log('  목록 행 태그 :', rowTag)
console.log('  → 목록도 해결로 :', ok(rowTag.includes('done')), '(두 곳이 어긋나면 안 된다)')

console.log('\n[5] 영상이 없는 이벤트')
await ev(`(()=>{const li=[...document.querySelectorAll('#pStatus .elog li')].find(x=>x.textContent.includes('과열'))
  li?.querySelector('.logopen')?.click()})()`)
await sleep(1800)
console.log('  안내 :', await ev(`document.querySelector('#evdNoVideo')?.textContent`))
console.log('  → 없음 안내 :', ok(!!(await ev(`!!document.querySelector('#evdNoVideo')`))))
console.log('  → 재생 요소 없음 :', ok(!(await ev(`!!document.querySelector('#evdVideo')`))))
await ev(`[...document.querySelectorAll('.modal button, [role=dialog] button')].find(b=>b.textContent.trim()==='닫기')?.click()`)
await sleep(700)

console.log('\n[6] 서버가 받지 않는 상태값을 FE 가 만들지 않는가')
const patches = be.restCalls.filter((c) => c.method === 'PATCH' && /^\/api\/events\/\d+$/.test(c.url || ''))
const statuses = [...new Set(patches.map((c) => c.body?.status))]
console.log('  보낸 status :', statuses.join(', '))
console.log('  → UNRESOLVED|RESOLVED 뿐 :', ok(statuses.every((s) => s === 'RESOLVED' || s === 'UNRESOLVED')))
const direct = await ev(`(async()=>{const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  const r=await fetch('http://127.0.0.1:8099/api/events/1001',{method:'PATCH',
    headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},
    body:JSON.stringify({status:'ACKNOWLEDGED'})}); return r.status})()`)
console.log('  (참고) ACKNOWLEDGED 직접 전송 :', direct, '← 서버가 받지 않는다')

console.log('\n[7] 뷰어는 상태를 바꿀 수 없다')
await ev(`[...document.querySelectorAll('.usermenu-btn')][0]?.click()`); await sleep(400)
await ev(`[...document.querySelectorAll('.usermenu-drop button')].find(b=>b.textContent.includes('로그아웃'))?.click()`); await sleep(1600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'viewer@bbiyong.io'); s(i[1],'password');
  document.querySelector('.auth-submit').click()})()`)
await sleep(3400)
await ev(`(()=>{const li=[...document.querySelectorAll('#pStatus .elog li')].find(x=>x.querySelector('.logopen'))
  li?.querySelector('.logopen')?.click()})()`)
await sleep(1800)
console.log('  상세 열림 :', ok(await ev(`!!document.querySelector('.evd-head')`)), '(조회는 된다)')
console.log('  → 상태 버튼 없음 :', ok(!(await ev(`!!document.querySelector('#btnEvdStatus')`))))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
