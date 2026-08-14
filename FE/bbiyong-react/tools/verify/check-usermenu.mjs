// 유저 메뉴 검증 — '열리는가' 가 아니라 '눌리는가' 를 잰다.
//
// 이 버그는 메뉴가 열리기는 하되 대시보드 뒤에 숨어 있었다. 존재만 확인하는 검사는
// 통과했을 것이다. 실제로 그 자리에 마우스를 놓고 무엇이 잡히는지 봐야 잡힌다.
// 겹침 순서(모달·경보가 nav 를 덮는가)도 함께 본다 — 한쪽을 올리면 다른 쪽이 밀린다.
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
  '--remote-debugging-port=9459', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9459/json/list')).json(); if (tg.length) break } catch {}
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value ?? '').join(' '))
}
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pend.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value

const enter = async (mode) => {
  await send('Page.navigate', { url: APP }); await sleep(1600)
  await ev(`localStorage.setItem('bbiyong.dataSource','${mode}')
    localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
    localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')
    sessionStorage.removeItem('bbiyong.fireAlarm')`)
  await send('Page.reload'); await sleep(2600)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  const e1 = mode === 'mock' ? 'safety@bbiyong.io' : 'test@bbiyong.io'
  const p1 = mode === 'mock' ? 'bbiyong' : 'password'
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'${e1}'); s(i[1],'${p1}'); document.querySelector('.auth-submit').click()})()`)
  await sleep(4200)
}
// 진짜 포인터로 누른다. JS click() 은 가려져 있어도 통과하므로 이 버그를 못 잡는다.
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(600)
}
const centerOf = (sel) => ev(`(()=>{const e=document.querySelector('${sel}'); if(!e) return null
  const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}})()`)
// 그 자리에서 실제로 잡히는 요소가 그 요소인지
const reachable = (sel) => ev(`(()=>{const e=document.querySelector('${sel}'); if(!e) return {ok:false,why:'요소 없음'}
  const r=e.getBoundingClientRect(); const el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2))
  return {ok: el===e || e.contains(el), hit: el ? el.tagName+'.'+String(el.className||'') : 'null'}})()`)

for (const mode of ['mock', 'live']) {
  console.log(`\n===== ${mode === 'mock' ? '시뮬레이션' : '실서버'} 모드 =====`)
  await enter(mode)
  const navZ = await ev(`(()=>{const n=getComputedStyle(document.querySelector('#nav'))
    return {z:n.zIndex, pos:n.position, bdf:String(n.backdropFilter||n.webkitBackdropFilter||'none')}})()`)
  console.log('  nav :', JSON.stringify(navZ))

  console.log('\n  [1] 계정 버튼을 눌러 메뉴가 열리는가')
  const btn = await centerOf('.usermenu-btn')
  const btnHit = await reachable('.usermenu-btn')
  console.log('    버튼이 잡힌다 :', ok(btnHit?.ok), btnHit?.ok ? '' : `(대신 ${btnHit?.hit})`)
  await clickAt(btn.x, btn.y)
  const items = await ev(`[...document.querySelectorAll('.usermenu-drop button')].map(b=>b.textContent.trim())`)
  console.log('    항목 :', (items || []).join(' / ') || '(안 열림)')
  console.log('    → 메뉴가 열린다 :', ok((items || []).length > 0))
  console.log('    → 마이페이지·로그아웃 포함 :',
    ok((items || []).some((t) => /마이페이지/.test(t)) && (items || []).some((t) => /로그아웃/.test(t))))

  console.log('\n  [2] 메뉴 항목을 실제로 누를 수 있는가 (이 버그의 핵심)')
  for (const [label, idx] of [['첫 항목', 0], ['마지막 항목', -1]]) {
    const r = await ev(`(()=>{const bs=[...document.querySelectorAll('.usermenu-drop button')]
      const b=${idx} < 0 ? bs[bs.length-1] : bs[${idx}]; if(!b) return {ok:false,why:'없음'}
      const q=b.getBoundingClientRect(); const el=document.elementFromPoint(Math.round(q.left+q.width/2),Math.round(q.top+q.height/2))
      return {label:b.textContent.trim(), ok: el===b||b.contains(el), hit: el?el.tagName+'.'+String(el.className||''):'null'}})()`)
    console.log(`    ${label} "${r?.label}" :`, ok(r?.ok), r?.ok ? '' : `← ${r?.hit} 가 가리고 있다`)
  }
  const my = await ev(`(()=>{const b=[...document.querySelectorAll('.usermenu-drop button')].find(x=>/마이페이지/.test(x.textContent))
    if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}})()`)
  if (my) await clickAt(my.x, my.y)
  const modalOpen = await ev(`!!document.querySelector('.modal-overlay')`)
  console.log('    → 마이페이지가 실제로 열린다 :', ok(modalOpen), '(포인터로 눌러 확인)')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `U-usermenu-${mode}.png`, Buffer.from(shot.data, 'base64'))
  if (modalOpen) {
    await ev(`[...document.querySelectorAll('.modal-overlay button')].find(b=>/닫기/.test(b.textContent))?.click()`)
    await sleep(500)
  }

  console.log('\n  [3] 겹침 순서 — nav 를 올렸다고 다른 것이 밀리면 안 된다')
  // 모달은 nav 를 덮어야 한다
  await clickAt(btn.x, btn.y)
  const my2 = await ev(`(()=>{const b=[...document.querySelectorAll('.usermenu-drop button')].find(x=>/마이페이지/.test(x.textContent))
    if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}})()`)
  if (my2) await clickAt(my2.x, my2.y)
  // 마이페이지 모달은 UserMenu 안에서 렌더되므로 DOM 상 #nav 내부다. nav 에 쌓임 맥락이
  // 생기면 모달의 z-index 도 그 안에 갇힌다 — 이 수정이 만들 수 있는 부작용이라 확인한다.
  // 중요한 것은 '모달이 대시보드를 덮는가' 이지 DOM 위치가 아니다.
  const modalOverPage = await ev(`(()=>{const o=document.querySelector('.modal-overlay')
    if(!o) return {ok:false,why:'모달 없음'}
    // 본문 한가운데에서 무엇이 잡히나 — 모달이 덮고 있어야 한다
    const el=document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2))
    const card=document.querySelector('.modal-overlay .modal, .modal-overlay > *')
    const cr=card?.getBoundingClientRect()
    const cardEl=cr?document.elementFromPoint(Math.round(cr.left+cr.width/2),Math.round(cr.top+30)):null
    return {ok: o===el || o.contains(el), hit: el?el.tagName+'.'+String(el.className||''):'null',
            cardReachable: !!cardEl && (card===cardEl || card.contains(cardEl))}})()`)
  console.log('    → 모달이 대시보드를 덮는다 :', ok(modalOverPage?.ok), `(본문 한가운데에서 ${modalOverPage?.hit})`)
  console.log('    → 모달 내용을 누를 수 있다 :', ok(modalOverPage?.cardReachable))
  await ev(`[...document.querySelectorAll('.modal-overlay button')].find(b=>/닫기/.test(b.textContent))?.click()`); await sleep(500)

  if (mode === 'live') {
    // 화재 경보는 nav 위에서도 보여야 한다
    be.push('/topic/alerts', { type: 'FIRE', level: 'CRITICAL', robotId: 'orinka_01', confidence: 0.9, timestamp: new Date().toISOString() })
    await sleep(1400)
    const flashOverNav = await ev(`(()=>{const n=document.querySelector('#nav'); const f=document.querySelector('.fireflash')
      if(!f) return {ok:false,why:'점멸 없음'}
      return {ok: Number(getComputedStyle(f).zIndex) > Number(getComputedStyle(n).zIndex), fz:getComputedStyle(f).zIndex, nz:getComputedStyle(n).zIndex}})()`)
    console.log('    → 화재 점멸이 nav 보다 위 :', ok(flashOverNav?.ok), `(점멸 ${flashOverNav?.fz} > nav ${flashOverNav?.nz})`)
    const ackHit = await reachable('#btnFireAck')
    console.log('    → 화재 확인 버튼이 눌린다 :', ok(ackHit?.ok), ackHit?.ok ? '' : `(대신 ${ackHit?.hit})`)
    await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(600)
  }
}

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
