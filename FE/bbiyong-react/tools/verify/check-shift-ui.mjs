// Shift 를 누르는 동안 버튼이 눌린 모양이 되는가 (FE 피드백)
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')
const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9371','--window-size=1600,1000','about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) { try { tg = await (await fetch('http://127.0.0.1:9371/json/list')).json(); if (tg.length) break } catch {} await sleep(500) }
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0; const pending = new Map(); const errs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value ?? '').join(' ')) }
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pending.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const key = (type, k = 'Shift', code = 'ShiftLeft', vk = 16) =>
  send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(type === 'keyDown' && k.length === 1 ? { text: k } : {}) })
const cls = () => ev(`({stop: document.querySelector('#pControl .dbtn.stop').className,
  go: document.querySelector('#pControl .dbtn.go.keyed').className})`)

// 로봇 흉내 — ESTOP 은 체결, SET_MODE autonomy 는 해제
let estop = 'RELEASED', seen = 0
setInterval(() => {
  for (; seen < be.sends.length; seen++) { let b; try { b = JSON.parse(be.sends[seen].body) } catch { continue }
    const c = (b.command || '').toUpperCase()
    if (c === 'ESTOP') estop = 'ENGAGED'; else if (c === 'SET_MODE' && b.mode === 'autonomy') estop = 'RELEASED' }
  be.push('/topic/robots', { robotId: 'orinka_01', status: 'AUTO_PATROL', battery: 71, speed: 0.1, estop, commLatencyMs: 27,
    capabilities: { lidar_map: 'online', camera: 'online', drive: 'online' } })
}, 400)

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`); await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(3600)
await ev(`document.activeElement?.blur()`)

console.log('\n[1] 해제 상태 — Shift 를 누르면 긴급 정지가 눌린 모양')
console.log('  누르기 전 :', JSON.stringify(await cls()))
await key('keyDown'); await sleep(250)
const held = await cls()
console.log('  누른 동안 :', JSON.stringify(held))
console.log('  → 긴급 정지 active :', ok(held.stop.includes('active')))
console.log('  → 순찰 복귀는 그대로 :', ok(!held.go.includes('active')))
const { data: s1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'SHIFT-held.png', Buffer.from(s1, 'base64'))
await key('keyUp'); await sleep(1500)
const after = await cls()
console.log('  뗀 뒤     :', JSON.stringify(after))
console.log('  → 표시 해제 :', ok(!after.stop.includes('active')))
console.log('  → 실제로 체결됨 :', ok((await ev(`document.querySelector('#pStatus .st.danger')?.textContent || ''`)).includes('체결')))

console.log('\n[2] 체결 상태 — 이번엔 순찰 복귀가 눌린 모양')
await key('keyDown'); await sleep(250)
const held2 = await cls()
console.log('  누른 동안 :', JSON.stringify(held2))
console.log('  → 순찰 복귀 active :', ok(held2.go.includes('active')))
console.log('  → 긴급 정지는 그대로 :', ok(!held2.stop.includes('active')))
await key('keyUp'); await sleep(1500)

console.log('\n[3] Shift + 다른 키는 단축키가 아니다 — 표시도 나오지 않는다')
await key('keyDown'); await sleep(150)
await key('keyDown', 'a', 'KeyA', 65); await sleep(200)
const combo = await cls()
console.log('  조합 중   :', JSON.stringify(combo))
console.log('  → 눌린 표시 없음 :', ok(!combo.stop.includes('active') && !combo.go.includes('active')))
await key('keyUp', 'a', 'KeyA', 65); await key('keyUp'); await sleep(800)

console.log('\n[4] 창을 벗어나면 눌린 채로 굳지 않는가')
await key('keyDown'); await sleep(200)
await ev(`window.dispatchEvent(new Event('blur'))`); await sleep(400)
const blurred = await cls()
console.log('  blur 뒤   :', JSON.stringify(blurred))
console.log('  → 표시 해제 :', ok(!blurred.stop.includes('active') && !blurred.go.includes('active')))
await key('keyUp'); await sleep(300)

console.log('\n[5] 뷰어 — 순찰 복귀는 누를 수 없으니 눌린 표시도 하지 않는다')
await ev(`[...document.querySelectorAll('.usermenu-btn')][0]?.click()`); await sleep(400)
await ev(`[...document.querySelectorAll('.usermenu-drop button')].find(b=>b.textContent.includes('로그아웃'))?.click()`); await sleep(1600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'viewer@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(3400)
await ev(`document.activeElement?.blur()`)
console.log('  현재 E-STOP :', await ev(`document.querySelector('#pStatus .st.danger')?.textContent?.trim() || '해제'`))
await key('keyDown'); await sleep(250)
const v = await cls()
console.log('  누른 동안 :', JSON.stringify(v))
console.log('  → 순찰 복귀 표시 없음 :', ok(!v.go.includes('active')))
await key('keyUp'); await sleep(600)

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 3) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
