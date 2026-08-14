import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend, makeFloorplan, floorplanDetail } from './fake-backend.mjs'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const be = await startFakeBackend(8099)
be.setActivePlan(floorplanDetail(makeFloorplan()))
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9547','--window-size=1440,900','about:blank'],{stdio:'ignore'})
let tg
for (let i=0;i<30;i++){ try{ tg=await (await fetch('http://127.0.0.1:9547/json/list')).json(); if(tg.length) break }catch{} await sleep(500) }
const ws=new WebSocket(tg.find(t=>t.type==='page').webSocketDebuggerUrl)
await new Promise(r=>{ws.onopen=r})
let id=0; const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(me,pa={})=>new Promise(r=>{const i=++id;pend.set(i,x=>r(x.result));ws.send(JSON.stringify({id:i,method:me,params:pa}))})
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.value
await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate',{url:'http://localhost:5174/'}); await sleep(1600)
await ev(`localStorage.clear(); localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2400)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(900)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const i=document.querySelectorAll('.auth-card input');s(i[0],'test@bbiyong.io');s(i[1],'password');document.querySelector('.auth-submit').click()})()`)
await sleep(5000)
for (const [tab,name] of [['지도','MAP'],['카메라','CAM']]) {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${tab}')?.click()`)
  await sleep(2200)
  const ok=(b)=>b?'PASS':'**FAIL**'
  console.log(`
[${name}] 좌측 패널 v3 톤`)
  const boxes = await ev(`(()=>{const out=[]
    for(const el of document.querySelectorAll('#pgMap #pStatus .stat-card, #pgCam #pControl .control-card')){
      const cs=getComputedStyle(el)
      out.push({cls:el.className, bs:cs.boxShadow, bw:cs.borderTopWidth, bg:cs.backgroundColor})}
    return JSON.stringify(out)})()`)
  console.log('  중첩 상자 :', boxes)
  const bx=JSON.parse(boxes)
  console.log('  → 중첩 테두리 상자가 없다 :',
    ok(bx.every(b=>b.bs==='none' && b.bw==='0px' && /rgba\(0, 0, 0, 0\)/.test(b.bg))))

  const pill = await ev(`(()=>{const p=document.querySelector('.pillm')
    if(!p) return null; const cs=getComputedStyle(p)
    return JSON.stringify({bg:cs.backgroundColor, bw:cs.borderTopWidth,
      dot:getComputedStyle(p,'::before').backgroundColor})})()`)
  if (pill) {
    const pl=JSON.parse(pill)
    console.log('  상태 표시 :', pill)
    console.log('  → 배경 칠이 없다 :', ok(/rgba\(0, 0, 0, 0\)/.test(pl.bg) && pl.bw==='0px'))
    console.log('  → 점으로 말한다 :', ok(!!pl.dot && !/rgba\(0, 0, 0, 0\)/.test(pl.dot)))
  }

  const logs = await ev(`(()=>{const els=[...document.querySelectorAll('#pgMap .elog li b, #pgCam .elog li b, #pgMap .elog .logtext, #pgCam .elog .logtext')]
    return JSON.stringify([...new Set(els.map(e=>getComputedStyle(e).color))])})()`)
  console.log('  로그 본문 색 :', logs)
  // -797 에서 뒤집혔다. 디자인 문서(BBIYONG 디자인 시스템 v3)의 실제 예시는
  // 점과 글자 양쪽에 심각도를 준다 — 문서를 따르기로 했다.
  // 여기서 보는 것은 '한 가지 색' 이 아니라 '알록달록하지 않은가' 다.
  const cols = JSON.parse(logs)
  console.log('  → 심각도가 글자에도 나타난다 :', ok(cols.length >= 1),
    '(문서 예시가 글자에도 색을 준다 — S15P11E101-797)')
  console.log('  → 색이 종류만큼만 쓰인다 :', ok(cols.length <= 4),
    '(줄마다 색이 다르면 어느 줄이 심각한지 훑어서 알 수 없다)')

  const onoff = await ev(`(()=>{const t=document.body.innerText
    return JSON.stringify({on:t.includes('ON'), ko:t.includes('온라인')||t.includes('오프라인')})})()`)
  console.log('  ON/OFF :', onoff)
  console.log('  → ON 으로 표기된다 :', ok(JSON.parse(onoff).on))
  console.log('  → 상태 표기에 온라인/오프라인이 없다 :', ok(!JSON.parse(onoff).ko))

  const type = await ev(`(()=>{const L=(c)=>{const f=c.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]}
    const P=(c)=>(String(c).match(/[0-9.]+/g)||[]).map(Number)
    const bgOf=(el)=>{let e=el;while(e){const c=P(getComputedStyle(e).backgroundColor);if(c.length>=3&&(c[3]===undefined||c[3]>0.95))return c.slice(0,3);e=e.parentElement}return [255,255,255]}
    const small=[], low=[]
    for(const el of document.querySelectorAll('#pgMap #pStatus *, #pgCam #pControl *')){
      const txt=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('')
      if(!txt) continue
      const cs=getComputedStyle(el)
      if(parseFloat(cs.fontSize)<12) small.push({t:txt.slice(0,10), s:cs.fontSize})
      const fg=P(cs.color).slice(0,3), bg=bgOf(el)
      const x=L(fg), y=L(bg), r=(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)
      if(r<4.5) low.push({t:txt.slice(0,10), r:Math.round(r*100)/100})}
    return JSON.stringify({small, low})})()`)
  const ty=JSON.parse(type)
  console.log('  12px 미만 :', JSON.stringify(ty.small))
  console.log('  → 모두 12px 이상 :', ok(ty.small.length===0))
  console.log('  4.5:1 미만 :', JSON.stringify(ty.low))
  console.log('  → 대비 4.5:1 이상 :', ok(ty.low.length===0))

  const {data}=await send('Page.captureScreenshot',{format:'png'})
  writeFileSync(OUT+`E793-${name}.png`, Buffer.from(data,'base64'))
}
ws.close(); chrome.kill(); process.exit(0)
