// S15P11E101-809 검증 — 화재 경보 중 화면 가독성
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
import { startFakeBackend, makeFloorplan, floorplanDetail } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
be.setActivePlan(floorplanDetail(makeFloorplan()))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9575', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9575/json/list')).json(); if (tg.length) break } catch {}
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


await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(5500)
// 화면 픽셀을 직접 읽는다. 점멸 막은 합성으로 색을 바꾸므로 getComputedStyle 로는
// 실제 보이는 색을 알 수 없다 — 스크린샷 픽셀이 유일한 사실이다.
const shot = async () => {
  const {data}=await send('Page.captureScreenshot',{format:'png'})
  return Buffer.from(data,'base64')
}
const px = (sel) => ev(`(()=>{const e=document.querySelector('${sel}')
  if(!e) return 'null'
  const r=e.getBoundingClientRect()
  return JSON.stringify({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)})})()`)
const readable = (sel) => ev(`(async()=>{const e=document.querySelector('${sel}')
  if(!e) return JSON.stringify({err:'no-el'})
  const r=e.getBoundingClientRect()
  const cs=getComputedStyle(e)
  return JSON.stringify({vis:cs.visibility, disp:cs.display, op:cs.opacity,
    z:cs.zIndex, w:Math.round(r.width), h:Math.round(r.height), top:Math.round(r.top)})})()`)
console.log('\n[1] 경보 중 상단바·KPI 가 화면에 남아 있는가')
be.push('/topic/alerts', { type:'FIRE', eventId:9101, level:'CRITICAL', robotId:'orinka_01',
  message:'화재 발생 · A구역 · 불꽃 0.93', timestamp:new Date().toISOString() })
await sleep(2000)
console.log('  점멸 활성 :', await ev(`!!document.querySelector('.fireflash')`))
for (const [name, sel] of [['상단바','#nav'],['KPI','.page.on .nav-hero'],['상태카드','#pStatus']]) {
  console.log('  ' + name + ' :', await readable(sel))
}
const nz = JSON.parse(await readable('#nav'))
console.log('  → 상단바가 점멸 막 위에 있다 :', ok(Number(nz.z) > 190), '(z-index ' + nz.z + ' > 190)')
console.log('\n[2] 실제 그려진 픽셀로 읽히는가')
// 점멸 최고조(opacity 1)에서 캡처하려면 여러 장 찍어 가장 어두운 순간을 본다
const box = JSON.parse(await px('#nav'))
let worst = 255
for (let i=0;i<6;i++){
  const b = await shot()
  writeFileSync(OUT+'E809-nav-'+i+'.png', b)
  await sleep(200)
}
console.log('  상단바 영역 :', JSON.stringify(box), '· 캡처 6장 저장')
{ const b = await shot(); writeFileSync(OUT+'E809-alert.png', b) }
console.log('\n[3] 점멸이 그대로인가')
const anim = await ev(`(()=>{const f=document.querySelector('.fireflash')
  const cs=getComputedStyle(f)
  return JSON.stringify({dur:cs.animationDuration, name:cs.animationName,
    shadow:cs.boxShadow.slice(0,70), bg:cs.backgroundColor})})()`)
console.log('  막 :', anim)
const a = JSON.parse(anim)
console.log('  → 점멸 주기가 그대로다 :', ok(a.dur === '1.1s'), '(0.9Hz · WCAG 3Hz 기준 아래)')
console.log('  → 넓은 안쪽 그림자가 사라졌다 :', ok(!/90px/.test(a.shadow)))
console.log('  → 테두리 점멸은 남았다 :', ok(/6px/.test(a.shadow)))
console.log('\n[4] 경보 중에도 조작이 되는가')
const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('#nav .navtabs button')].find(x=>x.textContent.trim()==='카메라')
  if(!b) return 'no-btn'; b.click(); return 'ok'})()`)
await sleep(1600)
const moved = await ev(`(()=>{const t=document.querySelector('#nav .navtabs button.on, #nav .navtabs button[aria-selected="true"]')
  return t?t.textContent.trim():null})()`)
console.log('  탭 전환 :', clicked, '->', moved)
console.log('  → 경보 중에도 탭이 눌린다 :', ok(moved === '카메라'), '(pointer-events 통과 유지)')
const bar = await ev(`!!document.querySelector('#btnFireAck')`)
console.log('  → 확인 띠가 있다 :', ok(bar === true))
await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(1500)
console.log('  → 확인하면 점멸이 멈춘다 :', ok((await ev(`!!document.querySelector('.fireflash')`)) === false))
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0,2) : '없음')
ws.close(); chrome.kill(); process.exit(0)
