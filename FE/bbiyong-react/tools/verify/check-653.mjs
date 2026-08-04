// S15P11E101-653 검증 — 유휴 자동 로그아웃 → 조작 잠금 전환
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
  '--remote-debugging-port=9441', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9441/json/list')).json(); if (tg.length) break } catch {}
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

const lockedUI = () => ev(`!!document.querySelector('.lockbar')`)
const login = async (mode, email = 'test@bbiyong.io', pw = 'password') => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],${JSON.stringify(email)}); s(i[1],${JSON.stringify(pw)});
    document.querySelector('.auth-submit').click()})()`)
  await sleep(4000)
}
const enter = async (mode) => {
  await send('Page.navigate', { url: APP }); await sleep(1600)
  await ev(`localStorage.setItem('bbiyong.dataSource','${mode}')
    localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
    localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')
    sessionStorage.removeItem('bbiyong.fireAlarm')`)
  await send('Page.reload'); await sleep(2600)
  await login(mode, mode === 'mock' ? 'safety@bbiyong.io' : 'test@bbiyong.io', mode === 'mock' ? 'bbiyong' : 'password')
}
// 유휴 1시간을 실제로 기다릴 수 없다 — 마지막 활동 시각을 과거로 밀고 5초 판정을 기다린다.
const goIdle = async (minsAgo = 70) => {
  await ev(`localStorage.setItem('bbiyong.activity', String(Date.now() - ${minsAgo}*60*1000))`)
  for (let i = 0; i < 16; i++) { if (await lockedUI()) return true; await sleep(700) }
  return false
}
const setLockedAt = (msAgo) => ev(`localStorage.setItem('bbiyong.lockedAt', String(Date.now() - ${msAgo}))`)

await send('Page.enable'); await send('Runtime.enable')
await enter('live')

// 긴급 정지·순찰 복귀 버튼은 조작 패널에서 걷어냈다(S15P11E101-688).
// 명령은 Shift 단축키로 남아 있다 — 한 번 누르면 정지, 다시 누르면 순찰 복귀 토글이다.
const shiftTap = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft',
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 })
  }
}

console.log('\n[1] 유휴가 지나면 로그아웃 대신 잠기는가')
console.log('  평소 잠금 :', ok(!(await lockedUI())))
const locked1 = await goIdle(70)
console.log('  → 잠김 :', ok(locked1))
console.log('  → 로그인 화면으로 튕기지 않음 :', ok(await ev(`!!document.querySelector('#pgB')`)))
console.log('  → 로그아웃 안내 없음 :', ok(!(await ev(`!!document.querySelector('.auth-card')`))))
console.log('  안내 :', await ev(`document.querySelector('.lockbar-txt b')?.textContent`))

console.log('\n[2] 잠긴 동안에도 감시가 계속되는가')
const before = be.sends.length
be.push('/topic/robots', { robotId: 'orinka_01', battery: 71, estop: 'RELEASED', mode: 'PATROL', timestamp: new Date().toISOString() })
await sleep(1500)
const link = await ev(`[...document.querySelectorAll('#pControl h3 .k')].map(e=>e.textContent.trim()).join(' | ')`)
console.log('  조작 패널 헤더 :', link)
console.log('  → STOMP 연결 유지 :', ok(/LIVE|로봇 오프라인/.test(String(link))), '(DISCONNECTED 가 아니어야 한다)')
console.log('  → 영상 패널 그대로 :', ok(await ev(`!!document.querySelector('#pCam canvas')`)))
console.log('  → 2D 지도 그대로 :', ok(await ev(`!!document.querySelector('#pMap canvas, .b-right canvas')`)))
console.log('  → 이벤트 로그 그대로 :', ok(await ev(`!!document.querySelector('#pStatus .elog')`)))
be.push('/topic/alerts', { type: 'FIRE', level: 'CRITICAL', robotId: 'orinka_01', confidence: 0.9, timestamp: new Date().toISOString() })
await sleep(1500)
console.log('  → 화재 경보 점멸 :', ok(await ev(`!!document.querySelector('.fireflash')`)), '(잠겨도 경보는 보여야 한다)')
console.log('  → 화재 확인 버튼 :', ok(await ev(`!!document.querySelector('#btnFireAck')`)))
await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(900)
console.log('  → 잠금 상태에서도 확인 가능 :', ok(!(await ev(`!!document.querySelector('.fireflash')`))), '(경보 확인은 조작이 아니라 안전 행위)')
const { data: s1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'L653-locked.png', Buffer.from(s1, 'base64'))

console.log('\n[3] 긴급 정지는 잠금과 무관하게 눌리는가')
const st0 = be.sends.length
await shiftTap(); await sleep(1200)
const stop = be.sends.slice(st0).find((s) => JSON.stringify(s).includes('ESTOP') || JSON.stringify(s).includes('EMERGENCY'))
console.log('  발행 :', stop ? JSON.stringify(stop.body).slice(0, 70) : '(없음)')
console.log('  → 실제로 발행됨 :', ok(!!stop), '(무인 시간대에 비밀번호부터 치게 할 수 없다)')

console.log('\n[4] 조작은 막히는가')
console.log('  → 모드 버튼 잠김 :', ok(await ev(`[...document.querySelectorAll('.seg button')].every(b=>b.disabled)`)))
console.log('  → 방향 패드 잠김 :', ok(await ev(`[...document.querySelectorAll('.dpad button')].every(b=>b.disabled)`)))
console.log('  → 모드 전환 잠김 :', ok(await ev(`[...document.querySelectorAll('.seg button')].every(b=>b.disabled)`)))
console.log('  → 카메라 각도 잠김 :', ok(await ev(`[...document.querySelectorAll('#camTilt .dbtn')].every(b=>b.disabled)`)))
const delBtns = await ev(`document.querySelectorAll('#pStatus .elog .logdel, #pStatus .elog .logopen ~ button').length`)
console.log('  → 이벤트 삭제/해결 버튼 사라짐 :', ok(delBtns === 0), `(${delBtns}개)`)

console.log('\n[5] 설정·운영 탭도 잠기는가')
for (const [idx, name, sel] of [[2, '설정', '#pgConfig'], [1, '운영', '#pgOps']]) {
  await ev(`[...document.querySelectorAll('.navtabs button')][${idx}]?.click()`); await sleep(1400)
  const shown = await ev(`!!document.querySelector('${sel}')`)
  const fs = await ev(`document.querySelector('${sel} .lockfs')?.disabled`)
  // fieldset[disabled] 은 자손의 disabled '프로퍼티'를 바꾸지 않는다 — 실제 상태는 :disabled 가 안다
  const anyEnabled = await ev(`[...document.querySelectorAll('${sel} .lockfs input, ${sel} .lockfs select, ${sel} .lockfs button')].some(b=>!b.matches(':disabled'))`)
  console.log(`  ${name} 탭 — 표시 ${shown} · fieldset disabled ${fs} · 살아 있는 조작 ${anyEnabled}`)
  console.log(`  → 값은 계속 보인다 :`, ok(shown), '(감추면 무엇이 설정됐는지 알 수 없다)')
  console.log(`  → 조작은 전부 막힘 :`, ok(fs === true && anyEnabled === false))
}
await ev(`[...document.querySelectorAll('.navtabs button')][0]?.click()`); await sleep(900)

console.log('\n[6] 새로고침해도 잠금이 유지되는가')
await send('Page.reload'); await sleep(3400)
console.log('  → 잠금 유지 :', ok(await lockedUI()), '(새로고침으로 열리면 잠금이 아니다)')
console.log('  → 세션 유지 :', ok(!(await ev(`!!document.querySelector('.auth-card')`))))

console.log('\n[7] 잠긴 화면에서 마우스를 움직여도 안 풀리는가')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 400, button: 'none' })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500, button: 'none' })
await sleep(6500)
console.log('  → 여전히 잠김 :', ok(await lockedUI()), '(움직였다고 풀리면 비밀번호를 묻는 의미가 없다)')

console.log('\n[8] 비밀번호로 풀리는가')
// 가짜 백엔드는 기본이 '아무 비밀번호나 통과'다 — 그대로 두면 틀린 비밀번호 경로를
// 아예 확인하지 못한다(처음에 이걸 놓쳐 오탐이 났다). 이 구간에서만 검사를 켠다.
be.setCheckPassword(true)
const wrongTried = await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelector('#lockPw'); if(!i) return false; s(i,'wrong-password'); document.querySelector('#btnUnlock').click(); return true})()`)
await sleep(2200)
console.log('  틀린 비밀번호 시도 :', wrongTried, '· 안내 :', await ev(`document.querySelector('#lockErr')?.textContent`))
console.log('  → 잠금 유지 :', ok(await lockedUI()))
console.log('  → 로그아웃되지 않음 :', ok(!(await ev(`!!document.querySelector('.auth-card')`))), '(오타 한 번에 관제가 끊기면 더 위험하다)')
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelector('#lockPw'); s(i,'password'); document.querySelector('#btnUnlock').click()})()`)
await sleep(2600)
console.log('  → 올바른 비밀번호로 해제 :', ok(!(await lockedUI())))
console.log('  → 조작 복구 :', ok(await ev(`[...document.querySelectorAll('.seg button')].every(b=>!b.disabled)`)))
console.log('  → 저장소 정리 :', ok(!(await ev(`localStorage.getItem('bbiyong.lockedAt')`))))
be.setCheckPassword(false)

console.log('\n[9] 잠금이 상한을 넘기면 로그아웃되는가')
await goIdle(70)
console.log('  다시 잠금 :', ok(await lockedUI()))
await setLockedAt(13 * 60 * 60 * 1000)   // 13시간 전에 잠긴 것으로
for (let i = 0; i < 14; i++) { if (await ev(`!!document.querySelector('.auth-card')`)) break; await sleep(700) }
console.log('  → 12시간 상한 초과 시 로그아웃 :', ok(await ev(`!!document.querySelector('.auth-card')`)))
const reason = await ev(`document.querySelector('.auth-card .form-msg, .auth-card .authmsg, .auth-card [class*=msg]')?.textContent?.trim()`)
console.log('  안내 :', reason)
console.log('  → 사유 안내 :', ok(!!reason && /잠금|로그아웃/.test(String(reason))))

console.log('\n[10] 사전 경고 모달이 사라졌는가')
await enter('live')
await goIdle(70)
console.log('  → 잠김 :', ok(await lockedUI()))
const warnModal = await ev(`!!document.querySelector('#sessionWarnBody, #btnExtendSession')`)
console.log('  → 계속 사용하시겠습니까 모달 없음 :', ok(!warnModal), '(밤새 11~12번 뜨던 것)')

console.log('\n[11] 직접 잠그기')
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelector('#lockPw'); s(i,'password'); document.querySelector('#btnUnlock').click()})()`)
await sleep(2400)
console.log('  해제 상태 :', ok(!(await lockedUI())))
await ev(`document.querySelector('.usermenu-btn')?.click()`); await sleep(500)
const hasLockNow = await ev(`!!document.querySelector('#btnLockNow')`)
await ev(`document.querySelector('#btnLockNow')?.click()`); await sleep(1200)
console.log('  → 메뉴에 있음 :', ok(hasLockNow), '· 즉시 잠김 :', ok(await lockedUI()))
console.log('  → 세션은 유지 :', ok(!(await ev(`!!document.querySelector('.auth-card')`))), '(로그아웃과 다르다)')

console.log('\n[12] 시뮬레이션 모드에서도 같은가')
await enter('mock')
console.log('  평소 :', ok(!(await lockedUI())))
console.log('  → 잠김 :', ok(await goIdle(70)))
// 잠금 중에도 정지는 나가야 한다 — 시뮬에서는 상태 패널의 E-STOP 표기로 확인한다
await shiftTap(); await sleep(1000)
console.log('  → 긴급 정지 열림 :', ok(/체결/.test(String(await ev(`document.querySelector('#pStatus .kv b.st')?.textContent`)))))
console.log('  → 조작 잠김 :', ok(await ev(`[...document.querySelectorAll('.seg button')].every(b=>b.disabled)`)))
const lockLog = await ev(`[...document.querySelectorAll('#pStatus .elog li')].map(l=>l.textContent).find(t=>/조작 잠금/.test(t))`)
console.log('  기록 :', (lockLog || '(없음)').replace(/\s+/g, ' ').trim())
console.log('  → 이벤트 로그에 남음 :', ok(!!lockLog))
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelector('#lockPw'); s(i,'bbiyong'); document.querySelector('#btnUnlock').click()})()`)
await sleep(2400)
console.log('  → 시뮬 계정 비밀번호로 해제 :', ok(!(await lockedUI())))
const unlockLog = await ev(`[...document.querySelectorAll('#pStatus .elog li')].map(l=>l.textContent).find(t=>/잠금 해제/.test(t))`)
console.log('  → 해제도 기록 :', ok(!!unlockLog))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
