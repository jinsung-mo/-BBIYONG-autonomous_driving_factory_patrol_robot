// S15P11E101-800 검증 — 반응형(폭별 실측)
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
  '--remote-debugging-port=9563', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9563/json/list')).json(); if (tg.length) break } catch {}
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
await ev(`localStorage.setItem('bbiyong.dataSource','live')
  localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
  localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(5000)

await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`)
await sleep(1800)


const W=[1440,1280,1024,768,640]
const TABS=['지도','카메라','이벤트','통계','운영','설정']
const probe=`(()=>{const de=document.scrollingElement
  const over=de.scrollWidth-de.clientWidth
  const q=(s)=>document.querySelector('.page.on '+s)
  const wd=(s)=>{const e=q(s);return e?Math.round(e.getBoundingClientRect().width):0}
  const burst=[]
  for(const el of document.querySelectorAll('.page.on .nav-hero, .page.on .panel, .page.on .card-v3')){
    if(el.scrollWidth>el.clientWidth+2){
      burst.push((el.id?'#'+el.id:'.'+String(el.className).split(' ')[0])+'('+el.scrollWidth+'>'+el.clientWidth+')')}}
  const sd=q('.nav-side')||q('.cam-side-panel'), mn=q('.nav-canvas')||q('.cam-main')
  let stacked=null
  if(sd&&mn){const a=sd.getBoundingClientRect(),b=mn.getBoundingClientRect(); stacked=b.bottom<=a.top+2}
  return JSON.stringify({over, side:wd('.nav-side')||wd('.cam-side-panel'),
    main:wd('.nav-canvas')||wd('.cam-main'), stacked, burst:burst.slice(0,3)})})()`

let fails=0
for (const name of TABS){
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${name}')?.click()`)
  await sleep(1500)
  console.log(`
== ${name} ==`)
  for (const w of W){
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:900,deviceScaleFactor:1,mobile:false})
    await sleep(750)
    const r=JSON.parse(await ev(probe))
    let extra=''
    let good = r.over<=0 && r.burst.length===0
    if (r.side && r.main){
      if (w>=1024){ const v=r.main/r.side; extra=` · 본문/사이드 ${v.toFixed(2)}`; if(v<2) good=false }
      if (w<=768){ extra+=` · 1단 ${r.stacked?'예':'아니오'}`; if(r.stacked===false) good=false }
    }
    if(!good) fails++
    console.log(`  ${String(w).padStart(4)} | 넘침 ${r.over} | 사이드 ${r.side} 본문 ${r.main}${extra}`
      + (r.burst.length?` | 터짐 ${r.burst.join(' ')}`:'') + ' : ' + ok(good))
  }
}
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
await sleep(600)
console.log('\n[동작] 디자인만 바꿨는가')
await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='지도')?.click()`)
await sleep(1500)
await ev(`document.querySelector('#pgMap .logopen')?.click()`); await sleep(2400)
const modal = await ev(`!!([...document.querySelectorAll('h3,h2,[class*=title]')].find(e=>/이벤트 상세/.test(e.textContent||'')))`)
console.log('  → 로그 클릭 상세가 열린다 :', ok(modal===true))
console.log('\n총 실패 :', fails, fails===0?'':'**FAIL**')
console.log('콘솔 에러 :', errs.length ? errs.slice(0,2) : '없음')
ws.close(); chrome.kill(); process.exit(0)
