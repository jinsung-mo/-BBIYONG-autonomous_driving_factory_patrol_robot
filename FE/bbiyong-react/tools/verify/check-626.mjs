// S15P11E101-626 검증 — DoD 두 항목을 시나리오로 확인한다.
//   1) access 만료 후에도 refresh 로 세션이 유지되어 재로그인 없이 관제가 지속된다
//   2) 일반 사용자에게 관리자 메뉴/사용자 권한 변경이 노출되지 않는다
// 613·614 의 내부 동작이 아니라 '운영에서 실제로 벌어지는 상황'을 본다.
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
  '--remote-debugging-port=9391', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let list
for (let i = 0; i < 30; i++) {
  try { list = await (await fetch('http://127.0.0.1:9391/json/list')).json(); if (list.length) break } catch {}
  await sleep(500)
}

// 탭 하나를 붙잡는 헬퍼 — 다중 탭 시나리오를 위해 두 개를 연다
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
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
  return { ws, send, ev, errs }
}

const login = async (tab, em = 'test@bbiyong.io') => {
  await tab.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await tab.ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],${JSON.stringify(em)}); s(i[1],'password');
    document.querySelector('.auth-submit').click()})()`)
  await sleep(3400)
}
const openApp = async (tab) => {
  await tab.send('Page.navigate', { url: APP }); await sleep(1600)
  await tab.ev(`localStorage.setItem('bbiyong.dataSource','live')`)
  await tab.send('Page.reload'); await sleep(2600)
}
const token = (tab) => tab.ev(`(()=>{try{return JSON.parse(localStorage.getItem('bbiyong.token')||'null')}catch{return null}})()`)
const tabs = (tab) => tab.ev(`[...document.querySelectorAll('.navtabs button')].map(b=>b.textContent.trim())`)
const onControl = (tab) => tab.ev(`!!document.querySelector('#pControl')`)

const A = await attach(list.find((t) => t.type === 'page'))
await openApp(A)
await login(A)

console.log('\n[DoD 1] access 만료 후에도 재로그인 없이 관제가 지속되는가')
const t0 = await token(A)
console.log('  최초 토큰 :', t0?.accessToken, '· refresh', t0?.refreshToken)
be.expireAccess()
// 관제 화면이 주기적으로 부르는 API 를 타게 한다
await A.ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[0];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'CRITICAL');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(2500)
const t1 = await token(A)
console.log('  갱신 후   :', t1?.accessToken, '· refresh', t1?.refreshToken)
console.log('  → 토큰 회전 :', ok(t1?.accessToken !== t0?.accessToken && t1?.refreshToken !== t0?.refreshToken))
console.log('  → 화면 유지 :', ok(await onControl(A)), '(재로그인 없음)')

console.log('\n[DoD 1-b] 다른 탭이 갱신한 토큰을 이 탭이 그대로 받아 쓰는가')
// 헤드리스의 새 탭은 localStorage 를 공유하지 않는다(확인함) — 진짜 두 탭 대신
// '다른 탭이 갱신을 끝내고 저장소에 새 토큰을 써 둔 순간'을 그대로 재현한다.
// 서버에는 실제로 refresh 를 태워 회전까지 일으킨다.
const before = await token(A)
const n0 = be.refreshCount()
const other = await A.ev(`(async()=>{
  const cur = JSON.parse(localStorage.getItem('bbiyong.token'))
  const r = await fetch('http://127.0.0.1:8099/api/auth/refresh',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ refreshToken: cur.refreshToken })})
  const res = await r.json()
  const next = { ...cur, accessToken: res.accessToken, refreshToken: res.refreshToken,
    expiresAt: Date.now() + res.expiresIn * 1000, expiresIn: res.expiresIn }
  localStorage.setItem('bbiyong.token', JSON.stringify(next))
  window.dispatchEvent(new StorageEvent('storage',{ key:'bbiyong.token' }))
  return res.accessToken })()`)
console.log('  다른 탭이 받은 토큰 :', other)
console.log('  → 회전 발생 :', ok(other !== before?.accessToken))
await sleep(2500)
const mark = be.restCalls.length
await A.ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[1];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'UNRESOLVED');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(2200)
const stale = be.restCalls.slice(mark).filter((c) => c.expired)
console.log('  갱신 호출 :', be.refreshCount() - n0, '회 (다른 탭이 한 1회뿐이어야 한다)')
console.log('  → 이 탭이 또 갱신하지 않음 :', ok(be.refreshCount() - n0 === 1))
console.log('  → 낡은 토큰으로 나간 요청 없음 :', ok(stale.length === 0), '(401 ' + stale.length + '건)')
console.log('  → 화면 유지 :', ok(await onControl(A)))

console.log('\n[DoD 2] 일반 사용자에게 관리자 메뉴가 노출되지 않는가')
await A.ev(`[...document.querySelectorAll('.usermenu-btn')][0]?.click()`); await sleep(400)
await A.ev(`[...document.querySelectorAll('.usermenu-drop button')].find(b=>b.textContent.includes('로그아웃'))?.click()`); await sleep(1600)
await login(A, 'viewer@bbiyong.io')
console.log('  등급 :', await A.ev(`document.querySelector('.navrole')?.textContent?.trim()`))
console.log('  탭   :', (await tabs(A)).join(' · '))
console.log('  → 관제만 :', ok((await tabs(A)).join() === '관제'))
console.log('  → 사용자 관리 화면 없음 :', ok(!(await A.ev(`!!document.querySelector('#pUsers')`))))
const forbid = await A.ev(`(async()=>{const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  const r=await fetch('http://127.0.0.1:8099/api/admin/users',{headers:{Authorization:'Bearer '+tok}}); return r.status})()`)
console.log('  → 서버도 막음 :', ok(forbid === 403), `(HTTP ${forbid})`)

console.log('\n[DoD 2-b] 운영 중 강등되면 관리자 화면을 계속 붙들고 있지 않는가')
await A.ev(`[...document.querySelectorAll('.usermenu-btn')][0]?.click()`); await sleep(400)
await A.ev(`[...document.querySelectorAll('.usermenu-drop button')].find(b=>b.textContent.includes('로그아웃'))?.click()`); await sleep(1600)
await login(A, 'test@bbiyong.io')
console.log('  로그인 등급 :', await A.ev(`document.querySelector('.navrole')?.textContent?.trim()`))
await A.ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()==='설정')?.click()`); await sleep(1800)
console.log('  사용자 관리 보임 :', ok(await A.ev(`!!document.querySelector('#usrList li')`)))
// 서버에서만 강등한다 — 화면은 아직 관리자로 알고 있다
be.users.find((u) => u.email === 'test@bbiyong.io').role = 'ROLE_USER'
be.demoteTokens()
await A.ev(`(()=>{const t=[...document.querySelectorAll('#pUsers button')].find(b=>b.textContent.includes('목록 새로 고침'));t&&t.click()})()`)
await sleep(3500)
console.log('  안내 :', await A.ev(`document.querySelector('#usrMsg')?.textContent`))
console.log('  등급 :', await A.ev(`document.querySelector('.navrole')?.textContent?.trim()`))
console.log('  탭   :', (await tabs(A)).join(' · '))
console.log('  → 사용자로 내려옴 :', ok((await A.ev(`document.querySelector('.navrole')?.textContent?.trim()`)) === '사용자'))
console.log('  → 관리자 메뉴 사라짐 :', ok((await tabs(A)).join() === '관제'))
console.log('  → 로그아웃되지 않음 :', ok(await onControl(A)), '(세션은 유효하다)')
const { data } = await A.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'A626-demoted.png', Buffer.from(data, 'base64'))

console.log('\n콘솔 에러:', A.errs.length ? A.errs.slice(0, 4) : '없음')
A.ws.close(); chrome.kill(); await be.close(); process.exit(0)
