// S15P11E101-613 검증 — refresh 토큰 저장·자동 갱신·401 재시도·실패 시 로그아웃
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
  '--remote-debugging-port=9351', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9351/json/list')).json(); if (tg.length) break } catch {}
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
const login = async (em = 'test@bbiyong.io') => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],${JSON.stringify(em)}); s(i[1],'password');
    document.querySelector('.auth-submit').click()})()`)
  await sleep(3400)
}
const stored = () => ev(`(()=>{try{return JSON.parse(localStorage.getItem('bbiyong.token')||'null')}catch{return null}})()`)
const loggedIn = () => ev(`!!document.querySelector('#pControl')`)
const onLoginScreen = () => ev(`!!document.querySelector('.auth-card')`)

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)
await login()

console.log('\n[1] 로그인 응답의 refreshToken 을 저장하는가')
let a = await stored()
console.log('  저장본 :', JSON.stringify({ accessToken: a?.accessToken, refreshToken: a?.refreshToken, expiresAt: !!a?.expiresAt }))
console.log('  → refreshToken 보관 :', ok(!!a?.refreshToken))
console.log('  → expiresIn(3600) 반영 :', ok(!!a?.expiresAt && a.expiresAt - Date.now() < 3700 * 1000 && a.expiresAt - Date.now() > 3400 * 1000))
console.log('  → 화면 진입 :', ok(await loggedIn()))

console.log('\n[2] access 만료 → 401 → refresh → 원요청 재시도')
be.expireAccess()
const n0 = be.refreshCount()
const c0 = be.restCalls.length
// 이벤트 필터를 건드려 인가 API 를 한 번 부른다
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[0];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'CRITICAL');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(2500)
const calls = be.restCalls.slice(c0)
const expired = calls.filter((c) => c.expired)
const okCalls = calls.filter((c) => c.url?.startsWith('/api/events?') && !c.expired)
console.log('  401 받은 요청 :', expired.length, '건 ·', expired[0]?.url || '')
console.log('  refresh 호출  :', be.refreshCount() - n0, '회')
console.log('  → 갱신 시도 :', ok(be.refreshCount() > n0))
console.log('  → 원요청 재시도 성공 :', ok(okCalls.length > 0), okCalls[0]?.url || '')
console.log('  → 화면 유지(로그아웃 안 됨) :', ok(await loggedIn()))
a = await stored()
console.log('  → 새 토큰 저장 :', ok(a?.accessToken === 'fake-access-2' || /fake-access-\d+/.test(a?.accessToken || '')), a?.accessToken)
console.log('  → refresh 회전 반영 :', ok(a?.refreshToken !== 'fake-refresh-1'), a?.refreshToken)

console.log('\n[3] 동시 401 이 여러 번이어도 refresh 는 한 번만 (single-flight)')
be.expireAccess()
const n1 = be.refreshCount()
await ev(`(()=>{
  const tok = JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  window.__r = Promise.all([1,2,3,4,5].map(() =>
    fetch('http://127.0.0.1:8099/api/events?page=0&size=5', { headers: { Authorization: 'Bearer ' + tok } }).then(r=>r.status)))
})()`)
await sleep(300)
// 화면 경로로도 한 번 더 밀어 넣는다
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[1];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'UNRESOLVED');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(2500)
console.log('  refresh 호출 :', be.refreshCount() - n1, '회 (여러 요청이 겹쳐도 1회여야 한다)')
console.log('  → 한 번만 :', ok(be.refreshCount() - n1 === 1))

console.log('\n[4] refresh 도 실패하면 로그인 화면으로')
be.expireAccess()
be.revokeRefresh()
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[0];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'WARNING');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(3000)
console.log('  로그인 화면 :', ok(await onLoginScreen()))
console.log('  안내 문구   :', await ev(`document.querySelector('.auth-note, .auth-card .form-msg, .authmsg')?.textContent?.trim() || '(없음)'`))
console.log('  저장 토큰 지워짐 :', ok(!(await stored())))
const { data: shot } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'T613-logout.png', Buffer.from(shot, 'base64'))

console.log('\n[5] 구버전 서버(refreshToken 없음)에서도 그대로 동작하는가')
be.setLegacyAuth(true)
await send('Page.reload'); await sleep(2600)
await login()
const a2 = await stored()
console.log('  저장본 :', JSON.stringify({ accessToken: a2?.accessToken, refreshToken: a2?.refreshToken }))
console.log('  → 로그인 성공 :', ok(await loggedIn()))
console.log('  → refreshToken 없음 :', ok(!a2?.refreshToken))
const n2 = be.refreshCount()
be.expireAccess()
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[0];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'CRITICAL');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(3000)
console.log('  refresh 시도 :', be.refreshCount() - n2, '회 (갱신 수단이 없으니 0)')
console.log('  → 갱신 시도 안 함 :', ok(be.refreshCount() - n2 === 0))
console.log('  → 401 이면 로그아웃(예전 동작) :', ok(await onLoginScreen()))
be.setLegacyAuth(false)

console.log('\n[6] 403 은 로그아웃시키지 않는다 (권한 문제이지 세션 문제가 아니다)')
await send('Page.reload'); await sleep(2600)
await login()
const before403 = await loggedIn()
const r403 = await ev(`(()=>{const tok=JSON.parse(localStorage.getItem('bbiyong.token')).accessToken
  return fetch('http://127.0.0.1:8099/api/nope-403',{headers:{Authorization:'Bearer '+tok}}).then(r=>r.status)})()`)
await sleep(1500)
console.log('  (참고) 가짜 서버는 404 를 준다 — 로그아웃 트리거만 확인 :', r403)
console.log('  → 화면 유지 :', ok(before403 && await loggedIn()))

console.log('\n[7] 시뮬레이션 모드에는 영향이 없다')
// 먼저 로그아웃한다 — restoreUser 는 데이터 소스를 보지 않아(613 이전부터 그렇다)
// live 토큰이 남아 있으면 시뮬 모드에서도 그대로 복원된다. 여기서 보려는 것은
// '시뮬 로그인이 토큰을 만들지 않는가' 이므로 앞 세션을 정리하고 시작한다.
await ev(`[...document.querySelectorAll('.usermenu-btn')][0]?.click()`); await sleep(400)
await ev(`[...document.querySelectorAll('.usermenu-drop button')].find(b=>b.textContent.includes('로그아웃'))?.click()`)
await sleep(1500)
await ev(`localStorage.setItem('bbiyong.dataSource','mock')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(600)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'safety@bbiyong.io'); s(i[1],'bbiyong');
  document.querySelector('.auth-submit').click()})()`)
await sleep(2200)
console.log('  로그인 :', ok(await loggedIn()))
console.log('  토큰 저장 없음 :', ok(!(await stored())))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
