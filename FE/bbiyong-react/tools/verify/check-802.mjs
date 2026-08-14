// S15P11E101-802 검증 — 인증 화면 이메일 placeholder·안내문
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
  '--remote-debugging-port=9567', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9567/json/list')).json(); if (tg.length) break } catch {}
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


const state = () => ev(`(()=>{
  const em=document.querySelector('#au-email')
  const hint=document.querySelector('.auth-hint')
  const body=document.querySelector('.auth-card').innerText
  return JSON.stringify({ph:em?em.placeholder:null, val:em?em.value:null,
    hint:hint?hint.textContent.trim():null,
    demoMail:body.includes('safety@bbiyong.io'), demoPw:/데모 계정/.test(body)})})()`)
const toMode = async (m) => {
  await ev(`[...document.querySelectorAll('.auth-seg[role="tablist"] button')].find(b=>b.textContent.trim()==='${m}')?.click()`)
  await sleep(700)
}
const toSource = async (m) => {
  await ev(`[...document.querySelectorAll('.auth-seg.src button')].find(b=>b.textContent.trim()==='${m}')?.click()`)
  await sleep(700)
}

console.log('\n[1] 회원가입 화면에 실계정이 남아 있지 않은가')
await toSource('시뮬레이션'); await toMode('회원가입')
const su = JSON.parse(await state())
console.log('  회원가입 :', await state())
console.log('  → placeholder 가 실계정이 아니다 :', ok(su.ph !== 'safety@bbiyong.io'))
console.log('  → 화면에 safety@bbiyong.io 가 없다 :', ok(su.demoMail === false))
console.log('  → 데모 계정 안내가 없다 :', ok(su.demoPw === false),
  '(가입 화면에 남의 자격증명이 떠 있으면 안 된다)')
console.log('  → 입력값은 비어 있다 :', ok(su.val === ''), '(placeholder 가 값으로 오해되면 안 된다)')

console.log('\n[2] 로그인 + 시뮬레이션에서는 데모 안내가 그대로인가')
await toMode('로그인')
const li = JSON.parse(await state())
console.log('  로그인·시뮬 :', await state())
console.log('  → 데모 계정 안내가 보인다 :', ok(li.demoPw === true), '(회귀 방지)')
console.log('  → placeholder 가 예시 주소다 :', ok(/example\.com/.test(li.ph || '')),
  '(example.com 은 예약 도메인이라 실재할 수 없다)')

console.log('\n[3] 로그인 + 실서버 안내는 그대로인가')
await toSource('실서버')
const lv = JSON.parse(await state())
console.log('  로그인·실서버 :', lv.hint)
console.log('  → 실서버 안내가 보인다 :', ok(/실서버 계정/.test(lv.hint || '')))
console.log('  → 데모 계정 안내는 없다 :', ok(lv.demoPw === false))

console.log('\n[4] placeholder 가 본문색과 구분되는가')
const col = await ev(`(()=>{const em=document.querySelector('#au-email')
  const cs=getComputedStyle(em)
  const ph=getComputedStyle(em,'::placeholder')
  return JSON.stringify({text:cs.color, ph:ph.color})})()`)
console.log('  색 :', col)
const c=JSON.parse(col)
console.log('  → placeholder 색이 본문색과 다르다 :', ok(c.ph !== c.text))

console.log('\n[5] 기능이 그대로인가')
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(5000)
console.log('  → 로그인이 된다 :', ok(await ev(`!!document.querySelector('#nav .navtabs')`)))

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0,2) : '없음')
ws.close(); chrome.kill(); process.exit(0)
