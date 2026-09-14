// S15P11E101-791 검증 — 로그인·회원가입 v3 디자인 적용
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
  '--remote-debugging-port=9535', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9535/json/list')).json(); if (tg.length) break } catch {}
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

// ---------------------------------------------------------------------------
console.log('\n[1] 다크 색값이 남아 있지 않은가')
const dark = await ev(`(()=>{const bad=['rgb(10, 12, 16)','rgb(18, 21, 27)','rgb(61, 220, 151)','rgb(14, 17, 22)','rgb(38, 43, 52)']
  const hits=[]
  for(const el of document.querySelectorAll('.auth-wrap, .auth-wrap *')){
    const cs=getComputedStyle(el)
    for(const prop of ['backgroundColor','color','borderTopColor']){
      if(bad.includes(cs[prop])) hits.push(el.className+'/'+prop+'='+cs[prop])
    }
  }
  return JSON.stringify(hits.slice(0,6))})()`)
console.log('  남은 다크 색 :', dark)
console.log('  → 다크 색값이 없다 :', ok(dark === '[]'),
  '(#0a0c10 / #12151b / #3ddc97 / #0e1116 / #262b34)')

// ---------------------------------------------------------------------------
console.log('\n[2] 카드가 흰 면 + 테두리 없이 그림자로 떠 있는가')
const card = await ev(`(()=>{const c=document.querySelector('.auth-card')
  if(!c) return null
  const cs=getComputedStyle(c)
  return JSON.stringify({bg:cs.backgroundColor, radius:cs.borderRadius,
    border:cs.borderTopWidth, shadow:cs.boxShadow.slice(0,40)})})()`)
console.log('  카드 :', card)
const cd = JSON.parse(card || 'null') || {}
console.log('  → 면이 흰색이다 :', ok(cd.bg === 'rgb(255, 255, 255)'))
console.log('  → 라운딩이 16px 이다 :', ok(cd.radius === '16px'))
console.log('  → 테두리가 없다 :', ok(cd.border === '0px'), '(테두리 대신 그림자로 층을 만든다)')
console.log('  → 그림자가 있다 :', ok(!!cd.shadow && cd.shadow !== 'none'))

// 씬 배경이 Welcome 과 이어지는가 — 밝은 면이어야 한다
const wrapBg = await ev(`(()=>{const w=document.querySelector('.auth-wrap')
  const cs=getComputedStyle(w)
  return JSON.stringify({img:cs.backgroundImage.slice(0,30), color:cs.backgroundColor})})()`)
console.log('  씬 :', wrapBg)
console.log('  → 씬이 그라디언트다 :', ok(/gradient/.test(JSON.parse(wrapBg).img)),
  '(평평한 회색이면 카드가 뜬 것이 아니라 상자로 보인다)')

// ---------------------------------------------------------------------------
console.log('\n[3] 채운 버튼이 화면당 하나뿐인가')
const filled = await ev(`(()=>{const bg=${RGB}
  const wrap=document.querySelector('.auth-wrap')
  const own=[]
  for(const b of wrap.querySelectorAll('button')){
    const cs=getComputedStyle(b)
    const c=(String(cs.backgroundColor).match(/[\\d.]+/g)||[]).map(Number)
    // 스스로 진한 배경을 칠한 버튼만 센다(투명은 제외)
    if(c.length<3) continue
    if(c[3]!==undefined && c[3]<0.5) continue
    const L=${LUM}
    if(L(c.slice(0,3))<0.35) own.push({t:b.textContent.trim().slice(0,10), bg:cs.backgroundColor})
  }
  return JSON.stringify(own)})()`)
console.log('  진하게 채운 버튼 :', filled)
const fl = JSON.parse(filled || '[]')
// 세그먼트의 선택된 알약은 '탭 상태 표시' 라 채운 버튼과 역할이 다르다.
// 그래도 화면에서 눈에 띄는 진한 면은 제출 하나 + 각 세그먼트의 선택 하나여야 한다.
const submitFilled = fl.filter((x) => /로그인|회원가입|처리/.test(x.t) && x.bg === 'rgb(76, 86, 149)')
console.log('  → 제출만 브랜드색으로 채워져 있다 :', ok(submitFilled.length === 1),
  '(#4C5695 — 채운 건 하나만)')
console.log('  → 나머지 진한 면은 세그먼트 선택뿐이다 :',
  ok(fl.every((x) => x.bg === 'rgb(76, 86, 149)' || x.bg === 'rgb(35, 39, 51)')))

// ---------------------------------------------------------------------------
console.log('\n[4] 글자가 12px 이상이고 대비가 4.5:1 이상인가')
const type = await ev(`(()=>{const bg=${RGB}; const ratio=${RATIO}
  const small=[], low=[]
  for(const el of document.querySelectorAll('.auth-wrap *')){
    if(!el.childNodes.length) continue
    const txt=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('')
    if(!txt) continue
    const cs=getComputedStyle(el)
    const size=parseFloat(cs.fontSize)
    if(size < 12) small.push({t:txt.slice(0,12), size})
    const fg=(String(cs.color).match(/[\\d.]+/g)||[]).map(Number).slice(0,3)
    const r=ratio(fg, bg(el))
    if(r < 4.5) low.push({t:txt.slice(0,12), r:Math.round(r*100)/100, color:cs.color})
  }
  return JSON.stringify({small, low})})()`)
const ty = JSON.parse(type || '{}')
console.log('  12px 미만 :', JSON.stringify(ty.small))
console.log('  → 모든 글자가 12px 이상이다 :', ok((ty.small || []).length === 0))
console.log('  4.5:1 미만 :', JSON.stringify(ty.low))
console.log('  → 대비가 4.5:1 이상이다 :', ok((ty.low || []).length === 0))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'E791-login.png', Buffer.from(data, 'base64'))
}

// ---------------------------------------------------------------------------
console.log('\n[5] 기능이 그대로 도는가')
// 회원가입 탭
await ev(`[...document.querySelectorAll('.auth-seg button')].find(b=>b.textContent.trim()==='회원가입')?.click()`)
await sleep(700)
const su = await ev(`JSON.stringify({
  rows: document.querySelectorAll('.auth-card .form-row').length,
  gender: !!document.querySelector('.auth-card .seg.gender'),
  submit: document.querySelector('.auth-submit')?.textContent.trim()})`)
console.log('  회원가입 :', su)
const suo = JSON.parse(su)
console.log('  → 회원가입 폼이 펼쳐진다 :', ok(suo.rows >= 6 && suo.gender === true))
console.log('  → 제출 문구가 바뀐다 :', ok(suo.submit === '회원가입'))
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'E791-signup.png', Buffer.from(data, 'base64'))
}

// 성별 세그먼트 선택이 보이는가
await ev(`document.querySelector('.auth-card .seg.gender button')?.click()`)
await sleep(400)
const gsel = await ev(`(()=>{const b=document.querySelector('.auth-card .seg.gender button.on')
  return b ? getComputedStyle(b).backgroundColor : null})()`)
console.log('  성별 선택 색 :', gsel)
console.log('  → 선택이 눈에 보인다 :', ok(gsel === 'rgb(35, 39, 51)'))

// 로그인으로 돌아가 오류 문구
await ev(`[...document.querySelectorAll('.auth-seg button')].find(b=>b.textContent.trim()==='로그인')?.click()`)
await sleep(600)
await ev(`document.querySelector('.auth-submit')?.click()`)
await sleep(700)
const errBox = await ev(`(()=>{const e=document.querySelector('.auth-card .form-msg.err')
  if(!e) return null
  const cs=getComputedStyle(e)
  return JSON.stringify({t:e.textContent.trim().slice(0,24), bg:cs.backgroundColor, color:cs.color})})()`)
console.log('  오류 :', errBox)
console.log('  → 오류 문구가 뜬다 :', ok(!!errBox))
const eb = JSON.parse(errBox || 'null')
if (eb) {
  const r = await ev(`(()=>{const ratio=${RATIO}
    const p=(c)=>(String(c).match(/[\\d.]+/g)||[]).map(Number).slice(0,3)
    return ratio(p('${eb.color}'), p('${eb.bg}'))})()`)
  console.log('  오류 문구 대비 :', Math.round(r * 100) / 100)
  console.log('  → 오류 문구가 읽힌다 :', ok(r >= 4.5))
}

// 자동 로그아웃 사유(.form-msg.warn)는 평소엔 안 뜬다. 실제로 한 장 그려서 잰다 —
// 선언만 보면 더 구체적인 규칙에 밀렸는지 알 수 없다.
const warn = await ev(`(()=>{const card=document.querySelector('.auth-card')
  const d=document.createElement('div'); d.className='form-msg warn'; d.textContent='세션이 만료되었습니다'
  card.appendChild(d)
  const cs=getComputedStyle(d)
  const r={bg:cs.backgroundColor, color:cs.color, size:cs.fontSize}
  d.remove(); return JSON.stringify(r)})()`)
const wn = JSON.parse(warn || '{}')
// 대비는 Node 에서 잰다 — 페이지 안에서 정규식을 문자열로 나르면 이스케이프가 깨진다
const num = (c) => (String(c).match(/[0-9.]+/g) || []).map(Number).slice(0, 3)
const lum = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2] }
const contrast = (a, b) => { const x = lum(num(a)), y = lum(num(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const wr = contrast(wn.color, wn.bg)
console.log('  자동 로그아웃 사유 :', warn, '· 대비', Math.round(wr * 100) / 100)
console.log('  → 사유 문구도 읽힌다 :', ok(wr >= 4.5))

// 실제 로그인이 되는가
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(5000)
const loggedIn = await ev(`!!document.querySelector('#nav .navtabs')`)
console.log('  → 로그인이 된다 :', ok(loggedIn), '(디자인만 바꾸고 동작은 그대로여야 한다)')

// ---------------------------------------------------------------------------
console.log('\n[6] 대시보드 모달 폼에 영향이 없는가')
// .form-row / .seg 는 공용이다. .auth-card 하위로 스코프하지 않으면 모달까지 바뀐다.
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`)
await sleep(1400)
await ev(`document.querySelector('#btnStartMapping')?.click()`)
await sleep(900)
const modal = await ev(`(()=>{const m=document.querySelector('.modal')
  if(!m) return null
  const row=m.querySelector('.form-row label') || document.querySelector('.nav-page .form-row label')
  return JSON.stringify({modal:true, label: row?getComputedStyle(row).fontSize:null})})()`)
console.log('  모달 :', modal)
const outside = await ev(`(()=>{const l=[...document.querySelectorAll('.form-row label')]
    .filter(e=>!e.closest('.auth-card'))
  if(!l.length) return 'none'
  return JSON.stringify(l.slice(0,3).map(e=>getComputedStyle(e).fontSize))})()`)
console.log('  인증 밖 .form-row label 크기 :', outside)
console.log('  → 인증 밖 폼은 11px 그대로다 :', ok(outside === 'none' || /11px/.test(outside)),
  '(공용 클래스가 새면 모달까지 같이 바뀐다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
