// S15P11E101-803 검증 — 실서버 안내 두 줄 + 로그인 후 지도 시작
//
// 완료 기준을 그대로 잰다. 전부 '화면에 실제로 나온 색·크기' 로 본다 —
// 클래스가 붙어 있어도 더 구체적인 규칙에 밀려 적용되지 않을 수 있다.
//   1. 다크 색값이 남아 있지 않다
//   2. 카드가 흰 면 + 테두리 없이 그림자로 떠 있다
//   3. 채운 버튼이 화면당 하나뿐이다
//   4. 모든 글자가 12px 이상, 대비 4.5:1 이상
//   5. 로그인·회원가입·오류·자동 로그아웃 사유가 정상 동작한다
//   6. 대시보드 모달(.form-row/.seg 공용)에 영향이 없다
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
  '--remote-debugging-port=9569', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9569/json/list')).json(); if (tg.length) break } catch {}
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
}
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pend.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
// 남은 세션이 있으면 대시보드로 바로 들어가 인증 화면을 볼 수 없다. 통째로 비운다.
await ev(`localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2400)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`)
await sleep(1800)
if (!(await ev(`!!document.querySelector('.auth-card')`))) {
  console.log('  DBG 화면 :', await ev(`JSON.stringify({url:location.href, cls:document.body.firstElementChild?.className,
    h:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim().slice(0,20)).slice(0,5),
    ls:Object.keys(localStorage)})`))
  console.log('  DBG 버튼 :', await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.textContent.trim().slice(0,16)).slice(0,8))`))
  await ev(`[...document.querySelectorAll('button')].find(b=>/접속|로그인|시작/.test(b.textContent||''))?.click()`)
  await sleep(1800)
}
console.log('  인증 화면 :', await ev(`!!document.querySelector('.auth-card')`) ? '떴다' : '없다')

// 실제로 칠해진 색을 합성해서 얻는다. 배경이 투명하면 부모 색이 보이는 것이므로
// 조상을 거슬러 올라가 처음 만나는 불투명 색을 쓴다.
const RGB = `(el)=>{
  const p=(c)=>{const n=String(c||'').match(/[\\d.]+/g)||[];return n.map(Number)}
  let e=el
  while(e){ const c=p(getComputedStyle(e).backgroundColor)
    if(c.length>=3 && (c[3]===undefined || c[3]>0.95)) return c.slice(0,3)
    e=e.parentElement }
  return [255,255,255]}`
const LUM = `(c)=>{const f=c.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)})
  return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]}`
const RATIO = `(a,b)=>{const L=${LUM};const x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}`



console.log('\n[1] 실서버 안내가 두 줄인가')
await ev(`[...document.querySelectorAll('.auth-seg.src button')].find(b=>b.textContent.trim()==='실서버')?.click()`)
await sleep(700)
const hint = await ev(`(()=>{const h=document.querySelector('.auth-hint')
  if(!h) return JSON.stringify({err:'no-el'})
  const r=h.getBoundingClientRect(); const cs=getComputedStyle(h)
  const lh=parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.5
  return JSON.stringify({br:h.getElementsByTagName('br').length,
    text:h.innerText, h:Math.round(r.height), lh:Math.round(lh), lines:Math.round(r.height/lh)})})()`)
console.log('  안내문 :', hint)
const hi = JSON.parse(hint)
console.log('  → 줄바꿈이 들어 있다 :', ok(hi.br >= 1))
console.log('  → 실제로 두 줄로 그려진다 :', ok(hi.lines >= 2), '(선언이 아니라 그려진 높이로 잰다)')

console.log('\n[2] 로그인하면 지도로 시작하는가')
// 이전 세션이 설정 화면에서 끝난 상황을 만든다 — 이것이 제보된 증상의 원인이다
await ev(`sessionStorage.setItem('section','config')`)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(5500)
const first = await ev(`(()=>{const on=document.querySelector('.page.on')
  const tab=document.querySelector('#nav .navtabs button.on, #nav .navtabs button[aria-selected="true"]')
  return JSON.stringify({page:on?on.id:null, tab:tab?tab.textContent.trim():null,
    stored:sessionStorage.getItem('section')})})()`)
console.log('  첫 화면 :', first)
const f = JSON.parse(first)
console.log('  → 첫 화면이 지도다 :', ok(f.tab === '지도' && f.stored === 'live'),
  '(이전 세션이 설정에서 끝났어도 관제의 첫 화면은 지도다)')
console.log('  → 저장된 화면도 지도다 :', ok(f.stored === 'live'))

console.log('\n[3] 세션 안에서 보던 화면은 지켜지는가')
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='통계')?.click()`)
await sleep(1200)
await send('Page.reload'); await sleep(4000)
const kept = await ev(`sessionStorage.getItem('section')`)
console.log('  새로고침 후 :', kept)
console.log('  → 새로고침은 보던 화면을 지킨다 :', ok(kept === 'stats'),
  '(로그인만 지도로 되돌린다 — 새로고침까지 되돌리면 작업 중이던 화면을 잃는다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0,2) : '없음')
ws.close(); chrome.kill(); process.exit(0)
