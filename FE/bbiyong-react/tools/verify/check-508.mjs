// S15P11E101-508 검증 — 세션 만료 · 유휴 처리 · 이벤트 로그로 세션 유지
// 5175 는 유휴 15초로 띄운 검증용 인스턴스다 (실제 기본값은 60분).
//
// S15P11E101-653 에서 유휴 정책이 바뀌었다: 유휴가 지나면 로그아웃하지 않고 조작만 잠근다.
// 이 파일의 유휴 항목들은 '로그아웃되는가' 대신 '잠기는가' 를 본다. 절대 만료 · 401 ·
// 수동 로그아웃 · 다른 탭 전파는 바뀌지 않았으므로 그대로 둔다.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const URL = APP
const ROBOT = 'orinka_01'
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9284', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9284/json/list')).json(); if (tg.length) break } catch {}
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

const loggedIn = () => ev(`!!document.querySelector('#nav')`)
const reasonText = () => ev(`document.querySelector('#logoutReason')?.textContent ?? '(없음)'`)
const warnShown = () => ev(`!!document.querySelector('#btnExtendSession')`)
const lockedUI = () => ev(`!!document.querySelector('.lockbar')`)
const alertEvt = (n) => ({ type: 'OVERHEAT', robotId: ROBOT, equipmentId: `분전반-${n}`, temperature: 57, threshold: 52, timestamp: new Date().toISOString() })

const login = async (source = 'live') => {
  await send('Page.navigate', { url: URL }); await sleep(1500)
  await ev(`localStorage.clear(); localStorage.setItem('bbiyong.dataSource','${source}')`)
  await send('Page.reload'); await sleep(2000)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(600)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'${source === 'live' ? 'admin@bbiyong.io' : 'safety@bbiyong.io'}'); s(i[1],'${source === 'live' ? 'password' : 'bbiyong'}')
    document.querySelector('.auth-submit').click()})()`)
  await sleep(source === 'live' ? 3500 : 1500)
}

await send('Page.enable'); await send('Runtime.enable')

console.log('\n[1] 유휴 자동 로그아웃 — 조작도 이벤트도 없을 때 (유휴 15초)')
await login()
console.log('  로그인 :', ok(await loggedIn()))
// 텔레메트리만 계속 흘린다 — 이것은 활동이 아니어야 한다
const telem = setInterval(() => be.push('/topic/robots',
  { robotId: ROBOT, status: 'AUTO_PATROL', battery: 80, speed: 0.3, estop: 'RELEASED' }), 500)
await sleep(11000)
console.log('  11초 뒤 :', await lockedUI() ? '잠김' : '아직 열림', '| 로그인 유지', await loggedIn())
await sleep(7000)
console.log('  18초 뒤 잠김 :', ok(await lockedUI()), '(로그아웃이 아니라 잠금 — S15P11E101-653)')
console.log('  세션은 유지 :', ok(await loggedIn()), '(무인 시간대에 감시가 끊기면 안 된다)')
console.log('  텔레메트리는 활동이 아님 :', ok(await lockedUI()), `(그동안 ${Math.round(22000 / 500)}건 수신)`)
clearInterval(telem)

console.log('\n[2] 이벤트 로그가 기록되면 세션 유지')
await login()
let n = 0
const evts = setInterval(() => be.push('/topic/alerts', alertEvt(++n)), 5000)
await sleep(26000)   // 유휴 15초의 1.7배 — 이벤트가 없었다면 이미 로그아웃
console.log('  26초 뒤 로그인 유지 :', ok(await loggedIn()), `(과열 이벤트 ${n}건 기록)`)
console.log('  잠기지 않음 :', ok(!(await lockedUI())))
console.log('  이벤트 로그 행 수 :', await ev(`document.querySelectorAll('#pStatus .elog li').length`))
clearInterval(evts)

console.log('\n[3] 이벤트가 끊기면 그때부터 유휴 판정')
await sleep(18000)
console.log('  이벤트 중단 18초 뒤 잠김 :', ok(await lockedUI()))
console.log('  세션은 유지 :', ok(await loggedIn()))

console.log('\n[4] 사전 경고 모달은 없어졌다 — 대신 비밀번호로 푼다')
await login()
await sleep(21000)
console.log('  잠김 :', ok(await lockedUI()))
console.log('  "계속 사용" 모달 없음 :', ok(!(await warnShown())), '(밤새 반복해 뜨던 것 — S15P11E101-653)')
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'X-508-locked.png', Buffer.from(shot.data, 'base64'))
be.setCheckPassword(true)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
  const i=document.querySelector('#lockPw'); s(i,'password'); document.querySelector('#btnUnlock').click()})()`)
await sleep(2500)
be.setCheckPassword(false)
console.log('  비밀번호로 해제 :', ok(!(await lockedUI())))
console.log('  조작 복구 :', ok(await ev(`document.querySelector('.dbtn.go')?.disabled === false`)))

console.log('\n[5] 브라우저를 닫았다 열면 — 세션은 살아나되 잠긴 채로 온다')
await ev(`localStorage.setItem('bbiyong.activity', String(Date.now() - 60*60*1000))
  localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload'); await sleep(2500)
console.log('  세션 복원 :', ok(await loggedIn()), '(유휴만으로는 더 이상 끊지 않는다)')
console.log('  잠긴 채로 :', ok(await lockedUI()), '(판정 주기를 기다리는 빈틈이 없어야 한다)')

console.log('\n[6] 절대 만료 — 토큰 수명이 다하면 로그아웃 (expiresIn=8초)')
// S15P11E101-613 이후 refreshToken 이 있으면 만료돼도 갱신돼 세션이 유지된다(그쪽은 check-613 이 본다).
// 이 시나리오가 보려는 것은 '갱신할 수 없을 때의 절대 만료'이므로 구버전 서버로 돌린다.
be.setLegacyAuth(true)
be.setExpiresIn(8)
await login()
console.log('  로그인 :', ok(await loggedIn()))
// 계속 조작해 유휴로는 절대 만료되지 않게 한다
const busy = setInterval(() => ev(`window.dispatchEvent(new Event('mousedown'))`), 1000)
await sleep(13000)
clearInterval(busy)
console.log('  조작 중에도 로그아웃 :', ok(!(await loggedIn())))
console.log('  안내 문구 :', await reasonText())
be.setExpiresIn(86400)
be.setLegacyAuth(false)

console.log('\n[7] REST 401 → 즉시 로그아웃')
await login()
console.log('  로그인 :', ok(await loggedIn()))
be.setRejectAuth(true)
// 앱 자신의 코드가 부르게 한다. 테스트가 authApi 를 따로 import 하면 Vite 가 다른 모듈
// 인스턴스를 줘서 bridge·onUnauthorized 가 등록되지 않은 사본으로 시험하게 된다(S15P11E101-626).
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[0];
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'CRITICAL');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(2500)
console.log('  401 뒤 로그아웃 :', ok(!(await loggedIn())))
console.log('  안내 문구 :', await reasonText())
be.setRejectAuth(false)

// 시뮬 로그(Simulation.pushLog)는 전 지점이 사용자 조작으로만 발생한다 — 두 활동 신호가
// 겹치므로 시뮬에서는 '이벤트만으로 유지'를 분리해 볼 수 없다. 같은 규칙이 적용되는지만 본다.
console.log('\n[8] 시뮬 모드에도 같은 규칙이 적용된다')
await login('mock')
console.log('  로그인 :', ok(await loggedIn()))
// 유휴 15초 + 판정 주기 5초 → 최대 20초. 여유를 두고 확인한다.
await sleep(24000)
console.log('  조작 없이 24초 뒤 잠김 :', ok(await lockedUI()))
console.log('  세션은 유지 :', ok(await loggedIn()))
console.log('  긴급 정지는 열려 있음 :', ok(await ev(`document.querySelector('.dbtn.stop')?.disabled === false`)))

console.log('\n[9] 사용자가 직접 로그아웃하면 사유 안내 없음')
await login()
console.log('  로그인 :', ok(await loggedIn()))
await ev(`document.querySelector('#nav .usermenu-btn')?.click()`); await sleep(400)
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/로그아웃/.test(x.textContent)); if(b) b.click()})()`)
await sleep(1200)
console.log('  로그아웃됨 :', ok(!(await loggedIn())))
console.log('  안내 문구 없음 :', ok((await reasonText()) === '(없음)'), '|', await reasonText())

console.log('\n[10] 다른 탭에서 활동하면 이 탭도 유지된다 (storage 동기화)')
await login()
const keep = setInterval(() => ev(`localStorage.setItem('bbiyong.activity', String(Date.now()))`), 4000)
await sleep(24000)
clearInterval(keep)
console.log('  24초 뒤 로그인 유지 :', ok(await loggedIn()))
console.log('\n[11] 다른 탭에서 로그아웃하면 이 탭도 나간다')
await ev(`localStorage.removeItem('bbiyong.token'); window.dispatchEvent(new StorageEvent('storage',{key:'bbiyong.token'}))`)
await sleep(1500)
console.log('  따라서 로그아웃 :', ok(!(await loggedIn())))

console.log('\n콘솔 에러 :', errs.length ? errs : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
