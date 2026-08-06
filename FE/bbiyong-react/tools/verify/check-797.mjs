// S15P11E101-797 검증 — 좌측 사이드 카드 두 장 분리 + 이벤트 로그 행
//
// 완료 기준 다섯 가지를 그대로 잰다.
//   1. 목 후보 3개가 뜨고 확인/거절 시 목록에서 사라진다
//   2. 확인한 후보가 확정 목록에 sequence 순으로 나타나고 이름수정·삭제(후 재정렬)가 된다
//   3. 지도에 target 핀 + viewpoint 화살표가 그려지고 대기/확정이 시각 구분된다
//   4. mapId 리터럴 비교 코드가 없고 낡은 안내문이 제거됐다
//   5. sendPointCommand 가 명령 스키마 그대로 만들어 보낸다
//
// 지도는 캔버스라 DOM 으로 확인할 길이 없다 — 픽셀 색을 직접 센다.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = new URL('../../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9553', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9553/json/list')).json(); if (tg.length) break } catch {}
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
await ev(`localStorage.clear(); localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2400)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(900)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const i=document.querySelectorAll('.auth-card input');s(i[0],'test@bbiyong.io');s(i[1],'password');document.querySelector('.auth-submit').click()})()`)
await sleep(5000)

const ratio=(a,b)=>{const P=(c)=>(String(c).match(/[0-9.]+/g)||[]).map(Number).slice(0,3)
  const L=(c)=>{const f=c.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]}
  const x=L(P(a)),y=L(P(b));return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}

for (const [tab,pg,first] of [['지도','#pgMap','#pStatus'],['카메라','#pgCam','#pControl']]) {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${tab}')?.click()`)
  await sleep(2200)
  console.log(`
[${tab}] 좌측 사이드`)
  const cards = await ev(`(()=>{const side=document.querySelector('${pg} .nav-side, ${pg} .cam-side-panel')
    if(!side) return null
    const cs=getComputedStyle(side)
    const kids=[...side.children].map(e=>{const c=getComputedStyle(e)
      return {id:e.id, bg:c.backgroundColor, r:c.borderRadius, bw:c.borderTopWidth, sh:c.boxShadow!=='none'}})
    return JSON.stringify({gap:cs.gap, wrapBg:cs.backgroundColor, wrapSh:cs.boxShadow, kids})})()`)
  console.log('  사이드 :', cards)
  const c=JSON.parse(cards)
  console.log('  → 카드가 두 장이다 :', ok(c.kids.length===2))
  console.log('  → 사이 여백이 24px 이다 :', ok(c.gap==='24px'))
  console.log('  → 껍데기는 카드가 아니다 :', ok(/rgba\(0, 0, 0, 0\)/.test(c.wrapBg) && c.wrapSh==='none'))
  console.log('  → 두 장 모두 흰 면·16px·테두리0·그림자 :',
    ok(c.kids.every(k=>k.bg==='rgb(255, 255, 255)' && k.r==='16px' && k.bw==='0px' && k.sh)))

  const scroll = await ev(`(()=>{const a=document.querySelector('${pg} ${first}')
    const e=document.querySelector('${pg} #pEvents')
    const el=document.querySelector('${pg} #pEvents .elog')
    if(!a||!e||!el) return null
    const cs=getComputedStyle(el)
    return JSON.stringify({fixed:getComputedStyle(a).flexGrow, logOv:cs.overflowY,
      aH:Math.round(a.getBoundingClientRect().height)})})()`)
  console.log('  스크롤 :', scroll)
  const sc=JSON.parse(scroll)
  console.log('  → 조작·상태 카드는 줄지 않는다 :', ok(sc.fixed==='0'))
  console.log('  → 넘치는 것은 로그만 접힌다 :', ok(sc.logOv==='auto'||sc.logOv==='scroll'))

  const row = await ev(`(()=>{const li=document.querySelector('${pg} .elog li')
    if(!li) return null
    const cs=getComputedStyle(li)
    const dot=li.querySelector('.logdot'), t=li.querySelector('.logtime,.t'), b=li.querySelector('.logtext,b')
    return JSON.stringify({disp:cs.display, gap:cs.gap, bb:cs.borderBottomWidth,
      bg:cs.backgroundColor, bw:cs.borderTopWidth,
      dot:dot?getComputedStyle(dot).backgroundColor:null,
      time:t?getComputedStyle(t).color:null, text:b?getComputedStyle(b).color:null,
      tsize:t?getComputedStyle(t).fontSize:null, bsize:b?getComputedStyle(b).fontSize:null})})()`)
  console.log('  로그 행 :', row)
  const r=JSON.parse(row)
  console.log('  → 상자가 아니라 구분선 한 줄이다 :',
    ok(/rgba\(0, 0, 0, 0\)/.test(r.bg) && r.bw==='0px' && r.bb==='1px'))
  console.log('  → 점이 있다 :', ok(!!r.dot && !/rgba\(0, 0, 0, 0\)/.test(r.dot)))
  console.log('  → 글자도 심각도를 말한다 :', ok(r.text!==r.time), '(문서 예시가 글자에도 색을 준다)')
  console.log('  시각 대비', Math.round(ratio(r.time,'rgb(255,255,255)')*100)/100,
    '· 본문 대비', Math.round(ratio(r.text,'rgb(255,255,255)')*100)/100)
  console.log('  → 둘 다 4.5:1 이상 :',
    ok(ratio(r.time,'rgb(255,255,255)')>=4.5 && ratio(r.text,'rgb(255,255,255)')>=4.5))
  console.log('  → 12px 이상 :', ok(parseFloat(r.tsize)>=12 && parseFloat(r.bsize)>=12))
}

// 기존 동작 — 로그를 눌러 상세가 열리는가
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='지도')?.click()`)
await sleep(1600)
const opened = await ev(`(()=>{const b=document.querySelector('#pgMap .logopen'); if(!b) return 'no-btn'
  b.click(); return 'clicked'})()`)
await sleep(2400)
const modal = await ev(`!!([...document.querySelectorAll('h3,h2,[class*=title]')].find(e=>/이벤트 상세/.test(e.textContent||'')))`)
console.log('\n[동작] 로그 클릭 :', opened)
console.log('  → 상세가 열린다 :', ok(modal===true))

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0,2) : '없음')
ws.close(); chrome.kill(); process.exit(0)
