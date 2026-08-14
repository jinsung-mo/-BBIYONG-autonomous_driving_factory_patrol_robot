// S15P11E101-643 검증 — 화재 미확인 적색 점멸 · 확인 처리
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=9433', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9433/json/list')).json(); if (tg.length) break } catch {}
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

const flashing = () => ev(`!!document.querySelector('.fireflash')`)
const ackBar = () => ev(`!!document.querySelector('#btnFireAck')`)
const fireToasts = () => ev(`document.querySelectorAll('.alert-toast.fire').length`)
const fire = (ts, robot = 'orinka_01') => be.push('/topic/alerts', {
  type: 'FIRE', level: 'CRITICAL', robotId: robot, confidence: 0.91, timestamp: ts,
})

const login = async () => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password');
    document.querySelector('.auth-submit').click()})()`)
  await sleep(3600)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live'); sessionStorage.removeItem('bbiyong.fireAlarm')`)
await send('Page.reload'); await sleep(2600)
await login()

// 긴급 정지·순찰 복귀 버튼은 조작 패널에서 걷어냈다(S15P11E101-688).
// 명령은 Shift 단축키로 남아 있다 — 한 번 누르면 정지, 다시 누르면 순찰 복귀 토글이다.
const shiftTap = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft',
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 })
  }
}

console.log('\n[1] 화재 경보가 오면 화면이 점멸하는가')
console.log('  평소 :', ok(!(await flashing())), '(경보 전에는 점멸하지 않는다)')
console.log('  구독자 :', fire('2026-08-03T21:04:00Z'), '명에게 FIRE 전달')
await sleep(1200)
console.log('  → 점멸 시작 :', ok(await flashing()))
console.log('  → 확인 띠 노출 :', ok(await ackBar()))
console.log('  → 토스트도 그대로 :', ok((await fireToasts()) === 1))
const { data: s1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'F643-flash.png', Buffer.from(s1, 'base64'))

console.log('\n[2] 다른 탭으로 옮겨도 계속되는가')
for (const [tab, label] of [[1, '운영'], [2, '설정']]) {
  await ev(`[...document.querySelectorAll('.navtabs button')][${tab}]?.click()`); await sleep(900)
  console.log(`  ${label} 탭 :`, ok(await flashing()), '· 확인 띠', ok(await ackBar()))
}
await ev(`[...document.querySelectorAll('.navtabs button')][0]?.click()`); await sleep(800)

console.log('\n[3] 확인 전에는 멈추지 않는가')
await sleep(6000)
console.log('  6초 경과 :', ok(await flashing()), '(저절로 사라지지 않는다)')
await ev(`document.querySelector('.alert-toast.fire .alert-toast-x')?.click()`); await sleep(700)
console.log('  토스트 ✕ :', await fireToasts(), '건 남음')
console.log('  → ✕ 로 닫아도 점멸 유지 :', ok(await flashing()), '(✕ 는 봤다는 뜻이 아니다)')
console.log('  → 확인 띠는 남아 있다 :', ok(await ackBar()), '(닫아버려 확인할 곳이 없어지면 안 된다)')

console.log('\n[4] 점멸이 조작을 막지 않는가')
// 조작 패널은 카메라 화면에 있다(S15P11E101-688). 다른 탭에 있으면 그 화면이 숨겨져 있어
// 좌표가 0,0 으로 잡히고, 엉뚱하게 상단바를 재게 된다 — 먼저 그 화면을 띄운다.
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='카메라')?.click()`)
await sleep(900)
const hit = await ev(`(()=>{const b=[...document.querySelectorAll('#pgCam .seg button')][0]; if(!b) return 'no-button'
  const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2)
  return el===b||b.contains(el) ? 'button' : (el?.className||el?.tagName||'?')})()`)
console.log('  모드 버튼 자리에서 잡히는 요소 :', hit)
console.log('  → 클릭이 통과한다 :', ok(hit === 'button'), '(pointer-events:none)')
const st0 = be.sends.length
await shiftTap(); await sleep(900)
const stop = be.sends.slice(st0).find((s) => JSON.stringify(s).includes('EMERGENCY') || JSON.stringify(s).includes('STOP'))
// S15P11E101-735 · 762 — 긴급 정지 수단은 의도적으로 전부 제거했다(버튼 688, 단축키 735).
// 그러니 여기서 잴 것은 '나가는가' 가 아니라 '없는 상태가 지켜지는가' 다.
// 되살리면 이 단언이 실패해 알려 준다 — 지금까지는 지워진 채 아무도 지키지 않았다.
console.log('  → 정지 명령이 나가지 않는다 :', ok(!stop), '(경보 중에도 세울 수단을 두지 않기로 했다)')
// 상세를 여는 버튼은 이벤트 화면의 로그에만 있다. 지도·카메라의 로그는 곁눈으로 보는
// 것이라 simple 로 줄여 두었기 때문이다(S15P11E101-751) — 상세는 그 화면에서 연다.
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='이벤트')?.click()`)
await sleep(1000)
await ev(`document.querySelector('#pgEvents .logopen')?.click()`); await sleep(1500)
console.log('  → 이벤트 상세 열림 :', ok(await ev(`!!document.querySelector('.evd-head')`)))
await ev(`[...document.querySelectorAll('.modal button, [role=dialog] button')].find(b=>b.textContent.trim()==='닫기')?.click()`); await sleep(700)

console.log('\n[5] 확인을 누르면 멈추는가')
const p0 = be.restCalls.length
await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(900)
console.log('  → 점멸 정지 :', ok(!(await flashing())))
console.log('  → 확인 띠 사라짐 :', ok(!(await ackBar())))
console.log('  → 화재 토스트 정리(경보음 정지) :', ok((await fireToasts()) === 0))
const patched = be.restCalls.slice(p0).filter((c) => c.method === 'PATCH')
console.log('  확인 이후 PATCH :', patched.length, '건')
console.log('  → 이벤트를 해결로 바꾸지 않는다 :', ok(patched.length === 0), '(확인은 봤다는 뜻일 뿐)')

console.log('\n[6] 확인 뒤 새 화재가 오면 다시 점멸하는가')
fire('2026-08-03T21:40:00Z'); await sleep(1200)
console.log('  → 재점멸 :', ok(await flashing()))
console.log('  → 토스트 확인 버튼도 있다 :', ok(await ev(`!!document.querySelector('#btnToastFireAck')`)))

console.log('\n[7] 새로고침해도 미확인 상태가 이어지는가')
await send('Page.reload'); await sleep(3400)
console.log('  → 점멸 유지 :', ok(await flashing()), '(서버 경보는 one-shot 이라 재수신되지 않는다)')
console.log('  → 확인 띠 유지 :', ok(await ackBar()))
await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(700)
console.log('  확인 후 :', ok(!(await flashing())))
await send('Page.reload'); await sleep(3200)
console.log('  → 확인한 뒤 새로고침하면 다시 뜨지 않는다 :', ok(!(await flashing())))

console.log('\n[8] 과열은 점멸 대상이 아니다')
be.push('/topic/alerts', { type: 'OVERHEAT', level: 'WARNING', equipmentId: 'panel_B', temperature: 62.1, threshold: 55, timestamp: '2026-08-03T22:00:00Z' })
await sleep(1300)
console.log('  과열 토스트 :', await ev(`document.querySelectorAll('.alert-toast.heat').length`), '건')
console.log('  → 토스트는 그대로 :', ok((await ev(`document.querySelectorAll('.alert-toast.heat').length`)) === 1))
console.log('  → 점멸 없음 :', ok(!(await flashing())), '(경고까지 점멸하면 화재를 구분할 수 없다)')
await ev(`document.querySelector('.alert-toast.heat .alert-toast-x')?.click()`); await sleep(500)

console.log('\n[9] 점멸 속도와 저감 모션')
const dur = await ev(`(()=>{const d=document.createElement('div'); d.className='fireflash'; document.body.appendChild(d)
  const s=getComputedStyle(d).animationDuration; d.remove(); return s})()`)
const hz = 1 / parseFloat(dur)
console.log('  주기 :', dur, '≈', hz.toFixed(2), 'Hz')
console.log('  → 초당 3회 미만 :', ok(hz < 3), '(WCAG 2.3.1 광과민성 발작 기준)')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
const durR = await ev(`(()=>{const d=document.createElement('div'); d.className='fireflash'; document.body.appendChild(d)
  const s=getComputedStyle(d); const v=[s.animationName, s.opacity]; d.remove(); return v})()`)
console.log('  저감 모션 :', durR?.join(' · '))
console.log('  → 깜빡임 대신 고정 표시 :', ok(durR?.[0] === 'none' && durR?.[1] === '1'))
await send('Emulation.setEmulatedMedia', { features: [] })

console.log('\n[10] 접근성 표기')
fire('2026-08-03T23:10:00Z'); await sleep(1200)
console.log('  확인 띠 role :', await ev(`document.querySelector('.fireflash-bar')?.getAttribute('role')`),
  '· aria-live :', await ev(`document.querySelector('.fireflash-bar')?.getAttribute('aria-live')`))
console.log('  점멸 막 aria-hidden :', await ev(`document.querySelector('.fireflash')?.getAttribute('aria-hidden')`))
const aname = await ev(`document.querySelector('#btnFireAck')?.getAttribute('aria-label')`)
console.log('  확인 버튼 이름 :', aname)
console.log('  → 스크린리더에 전달됨 :', ok(
  (await ev(`document.querySelector('.fireflash-bar')?.getAttribute('role')`)) === 'alert'
  && (await ev(`document.querySelector('.fireflash')?.getAttribute('aria-hidden')`)) === 'true'
  && !!aname))

console.log('\n[11] 시뮬레이션 모드에서도 같은가')
// 시뮬레이션에는 화재를 일으킬 UI 경로가 없다(설정 탭 시연 경보는 live 전용). 미확인 상태를
// 직접 심어 두고, mock 으로 들어갔을 때 같은 점멸·확인이 붙는지 본다.
await ev(`localStorage.setItem('bbiyong.dataSource','mock')
  sessionStorage.setItem('bbiyong.fireAlarm', JSON.stringify({pending:['sim:1'],seen:['sim:1']}))`)
await send('Page.reload'); await sleep(3400)
console.log('  모드 :', await ev(`localStorage.getItem('bbiyong.dataSource')`),
  '· 요약 띠 없음(=mock)', ok(!(await ev(`!!document.querySelector('#pSummary')`))))
console.log('  → 점멸 :', ok(await flashing()))
console.log('  → 확인 띠 :', ok(await ackBar()))
await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(700)
console.log('  → 확인으로 정지 :', ok(!(await flashing())))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
