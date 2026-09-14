// S15P11E101-614 검증 — 역할 기반 화면 분기 · 관리자 사용자 관리 · 비관리자 403 처리
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
  '--remote-debugging-port=9361', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9361/json/list')).json(); if (tg.length) break } catch {}
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
const login = async (em) => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],${JSON.stringify(em)}); s(i[1],'password');
    document.querySelector('.auth-submit').click()})()`)
  await sleep(3400)
}
const logout = async () => {
  await ev(`[...document.querySelectorAll('.usermenu-btn')][0]?.click()`); await sleep(400)
  await ev(`[...document.querySelectorAll('.usermenu-drop button')].find(b=>b.textContent.includes('로그아웃'))?.click()`)
  await sleep(1600)
}
const tabs = () => ev(`[...document.querySelectorAll('.navtabs button')].map(b=>b.textContent.trim())`)
const roleBadge = () => ev(`document.querySelector('.navrole')?.textContent?.trim() || '(없음)'`)
const goTab = async (t) => { await ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()===${JSON.stringify(t)})?.click()`); await sleep(1800) }

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)

console.log('\n[1] 사용자(ROLE_USER) — 메뉴·조작이 분기되는가')
await login('viewer@bbiyong.io')
console.log('  권한 배지 :', await roleBadge())
console.log('  → "사용자" 표기 :', ok((await roleBadge()) === '사용자'))
console.log('  탭        :', (await tabs()).join(' · '))
console.log('  → 관제만 :', ok((await tabs()).join() === '관제'))
console.log('  방향 버튼 잠김 :', ok(await ev(`[...document.querySelectorAll('#pControl .dpad button')].every(b=>b.disabled)`)))
console.log('  긴급 정지 가능 :', ok(!(await ev(`document.querySelector('#pControl .dbtn.stop').disabled`))), '(안전 예외)')
console.log('  사용자 관리 화면 없음 :', ok(!(await ev(`!!document.querySelector('#pUsers')`))))

console.log('\n[2] 관리자 — 사용자 목록이 보이는가')
await logout()
await login('test@bbiyong.io')
console.log('  권한 배지 :', await roleBadge())
console.log('  탭        :', (await tabs()).join(' · '))
console.log('  → 3개 탭 :', ok((await tabs()).length === 3))
await goTab('설정')
const rows = await ev(`[...document.querySelectorAll('#usrList li')].map(l=>l.textContent.replace(/\\s+/g,' ').trim())`)
console.log('  목록 :', (rows || []).join('\n         '))
console.log('  → 3명 조회 :', ok((rows || []).length === 3))
console.log('  → 본인 표시 :', ok((rows || []).some((r) => r.includes('나'))))
console.log('  → 등급 표기 :', ok((rows || []).some((r) => r.includes('관리자')) && (rows || []).some((r) => r.includes('사용자'))))

console.log('\n[3] 승격 — PATCH 가 나가고 그 행만 바뀌는가')
const c0 = be.restCalls.length
await ev(`(()=>{const li=[...document.querySelectorAll('#usrList li')].find(l=>l.textContent.includes('night@bbiyong.io'))
  const s=li.querySelector('select')
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'ROLE_ADMIN')
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(1600)
const patch = be.restCalls.slice(c0).find((c) => c.method === 'PATCH' && c.url === '/api/admin/users/role')
console.log('  요청 :', patch?.method, patch?.url, JSON.stringify(patch?.body))
console.log('  → { email, role } 전송 :', ok(patch?.body?.email === 'night@bbiyong.io' && patch?.body?.role === 'ROLE_ADMIN'))
console.log('  안내 :', await ev(`document.querySelector('#usrMsg')?.textContent`))
const after = await ev(`(()=>{const li=[...document.querySelectorAll('#usrList li')].find(l=>l.textContent.includes('night@bbiyong.io'))
  return li.textContent.replace(/\\s+/g,' ').trim()})()`)
console.log('  행 :', after)
console.log('  → 등급 갱신 :', ok(after.includes('관리자')))
console.log('  → 목록 재조회 없음 :', ok(!be.restCalls.slice(c0).some((c) => c.method === 'GET' && c.url === '/api/admin/users')))

console.log('\n[4] 되돌리기 어려운 변경은 확인을 받는가 — 자기 강등')
await ev(`(()=>{const li=[...document.querySelectorAll('#usrList li')].find(l=>l.textContent.includes('test@bbiyong.io'))
  const s=li.querySelector('select')
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'ROLE_USER')
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(700)
const modal = await ev(`document.querySelector('.modal-body')?.textContent?.replace(/\\s+/g,' ').trim() || '(없음)'`)
console.log('  모달 :', modal)
console.log('  → 확인 요구 :', ok(modal.includes('자기 자신')))
const c1 = be.restCalls.length
await ev(`[...document.querySelectorAll('.modal button, [role=dialog] button')].find(b=>b.textContent.trim()==='취소')?.click()`)
await sleep(600)
console.log('  → 취소하면 요청 없음 :', ok(!be.restCalls.slice(c1).some((c) => c.method === 'PATCH')))
const { data: shot1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'U614-admin.png', Buffer.from(shot1, 'base64'))

console.log('\n[5] 승격된 계정이 다음 로그인에서 관리자 화면을 받는가')
await logout()
await login('night@bbiyong.io')
console.log('  권한 배지 :', await roleBadge())
console.log('  탭        :', (await tabs()).join(' · '))
console.log('  → 관리자 화면 :', ok((await tabs()).length === 3))

console.log('\n[6] 서버가 403 을 주면 (화면은 관리자인데 서버는 아님) 사유를 알리는가')
await goTab('설정')
// 서버에서만 강등한다 — 403 판정은 발급된 토큰의 역할로 하므로 그것을 낮춘다.
// (users 배열만 고치면 이미 발급된 토큰은 여전히 관리자라 403 이 나지 않는다)
be.users.find((u) => u.email === 'night@bbiyong.io').role = 'ROLE_USER'
be.demoteTokens()
await ev(`(()=>{const t=[...document.querySelectorAll('#pUsers button')].find(b=>b.textContent.includes('목록 새로 고침'));t&&t.click()})()`)
await sleep(1800)
// S15P11E101-626 이후: 403 을 받으면 서버 판단 role 을 다시 받아 와 메뉴까지 내린다.
// 그래서 설정 탭과 이 패널이 사라지는 것이 정상이다 — 로그아웃은 되지 않는다.
await sleep(2500)
const role614 = await ev(`document.querySelector('.navrole')?.textContent?.trim()`)
const tabs614 = await ev(`[...document.querySelectorAll('.navtabs button')].map(b=>b.textContent.trim())`)
console.log('  등급 :', role614, '· 탭 :', (tabs614 || []).join(' · '))
console.log('  → 사용자로 내려옴 :', ok(role614 === '사용자'))
console.log('  → 관리자 메뉴 사라짐 :', ok((tabs614 || []).join() === '관제'))
console.log('  → 로그아웃되지 않음 :', ok(await ev(`!!document.querySelector('#pControl')`)), '(403 은 세션 문제가 아니다)')

console.log('\n[7] 시뮬레이션 모드 — 기존 뷰어 동작이 그대로인가')
await logout()
await ev(`localStorage.setItem('bbiyong.dataSource','mock')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(600)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'safety@bbiyong.io'); s(i[1],'bbiyong');
  document.querySelector('.auth-submit').click()})()`)
await sleep(2200)
console.log('  권한 배지 :', await roleBadge())
console.log('  탭        :', (await tabs()).join(' · '))
await goTab('설정')
console.log('  사용자 관리 안내 :', await ev(`document.querySelector('#pUsers .cfg-note')?.textContent?.trim() || '(없음)'`))
console.log('  → 조회 안 함 :', ok(!(await ev(`!!document.querySelector('#usrList li')`))))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
