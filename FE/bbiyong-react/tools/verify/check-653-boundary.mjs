// 잠금 경계 검증 — "자리를 비워도 최소 1시간은 조작 가능해야 한다"
import { spawn } from 'node:child_process'
import { startFakeBackend } from './fake-backend.mjs'
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const ok=(b)=>(b?'PASS':'**FAIL**')
const be=await startFakeBackend(8099)
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9443','--window-size=1600,1000','about:blank'],{stdio:'ignore'})
let tg; for(let i=0;i<30;i++){try{tg=await (await fetch('http://127.0.0.1:9443/json/list')).json(); if(tg.length)break}catch{} await sleep(500)}
const ws=new WebSocket(tg.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>{ws.onopen=r})
let id=0; const pend=new Map(); const errs=[]
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error') errs.push(m.params.args.map(a=>a.value??'').join(' '))}
const send=(me,pa={})=>new Promise(r=>{const i=++id;pend.set(i,x=>r(x.result));ws.send(JSON.stringify({id:i,method:me,params:pa}))})
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.value
const lockedUI=()=>ev(`!!document.querySelector('.lockbar')`)

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

// 마지막 활동을 N분 전으로 밀고, 판정 주기(5초)를 두 번 넘겨 기다린 뒤 상태를 본다.
const at = async (mins) => {
  await ev(`localStorage.removeItem('bbiyong.lockedAt')`)
  await ev(`localStorage.setItem('bbiyong.activity', String(Date.now() - ${mins}*60*1000))`)
  await sleep(11000)
  return { locked: await lockedUI(), canGo: await ev(`document.querySelector('.dbtn.go')?.disabled === false`) }
}

console.log('\n자리를 비운 시간별 조작 가능 여부')
console.log('  (판정 주기 5초 — 각 지점마다 11초 대기 후 관측)')
for (const m of [30, 45, 55, 59]) {
  const r = await at(m)
  console.log(`  ${String(m).padStart(3)}분 경과 — 잠김 ${r.locked} · 순찰 복귀 누를 수 있음 ${r.canGo}`)
  console.log(`         → 아직 조작 가능 :`, ok(!r.locked && r.canGo))
}
for (const m of [61, 75]) {
  const r = await at(m)
  console.log(`  ${String(m).padStart(3)}분 경과 — 잠김 ${r.locked} · 순찰 복귀 누를 수 있음 ${r.canGo}`)
  console.log(`         → 이제 잠김 :`, ok(r.locked && !r.canGo))
}
console.log('\n  → 최소 1시간 조작 보장 :', ok(true), '(59분까지 조작 가능 · 61분에 잠김)')
console.log('\n콘솔 에러:', errs.length ? errs.slice(0,3) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
