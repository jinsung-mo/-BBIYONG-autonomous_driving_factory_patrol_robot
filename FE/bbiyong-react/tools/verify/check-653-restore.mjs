// 재진입 빈틈 검증 — 유휴가 지난 뒤 새로 열면 '처음부터' 잠겨 있어야 한다
import { spawn } from 'node:child_process'
import { startFakeBackend } from './fake-backend.mjs'
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const ok=(b)=>(b?'PASS':'**FAIL**')
const be=await startFakeBackend(8099)
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9445','--window-size=1600,1000','about:blank'],{stdio:'ignore'})
let tg; for(let i=0;i<30;i++){try{tg=await (await fetch('http://127.0.0.1:9445/json/list')).json(); if(tg.length)break}catch{} await sleep(500)}
const ws=new WebSocket(tg.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>{ws.onopen=r})
let id=0; const pend=new Map()
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(me,pa={})=>new Promise(r=>{const i=++id;pend.set(i,x=>r(x.result));ws.send(JSON.stringify({id:i,method:me,params:pa}))})
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.value

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate',{url:APP}); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')
  localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
  localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
await sleep(4000)

console.log('\n유휴가 지난 뒤 브라우저를 다시 여는 상황')
// 잠금 기록 없이 '활동만 오래됨' 상태를 만든다 — 창을 닫아 둔 사이 유휴가 지난 경우
await ev(`localStorage.setItem('bbiyong.activity', String(Date.now() - 90*60*1000))
  localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload')
// 첫 화면이 그려지자마자 본다. 판정 주기(5초)를 기다리지 않는다 —
// 그 사이 조작이 열려 있으면 자리를 비운 사이 누가 만질 수 있다.
let sawUnlocked = false, firstSeen = null
for (let i = 0; i < 24; i++) {
  await sleep(250)
  const has = await ev(`!!document.querySelector('#pgB')`)
  if (!has) continue
  const locked = await ev(`!!document.querySelector('.lockbar')`)
  const canGo = await ev(`document.querySelector('.dbtn.go')?.disabled === false`)
  if (firstSeen === null) firstSeen = { locked, canGo, atMs: i * 250 }
  if (canGo) sawUnlocked = true
  if (i > 16) break
}
console.log('  화면이 처음 보인 시점 :', JSON.stringify(firstSeen))
console.log('  → 처음부터 잠겨 있다 :', ok(firstSeen?.locked === true))
console.log('  → 4초 동안 한 번도 조작이 열리지 않았다 :', ok(!sawUnlocked), '(판정 주기 5초를 기다리는 빈틈이 없어야 한다)')
console.log('  → 세션은 유지 :', ok(!(await ev(`!!document.querySelector('.auth-card')`))))
ws.close(); chrome.kill(); await be.close(); process.exit(0)
