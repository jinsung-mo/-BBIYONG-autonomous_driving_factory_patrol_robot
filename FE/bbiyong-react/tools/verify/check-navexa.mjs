// navexa 두 페이지 검증 — 구조 · 화면 맞춤 · 명료성 · 안전 조작 · 실서버 격리
//
// 명료성은 실제로 칠해지는 색으로 잰다. 선언된 색만 보면 그라데이션과 겹친 배경을 놓친다.
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
  '--remote-debugging-port=9477', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9477/json/list')).json(); if (tg.length) break } catch {}
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

// 실제로 칠해지는 색으로 대비를 잰다(그라데이션 정지점마다 재고 최악값)
const CONTRAST = `(sel)=>{
  const px=(s)=>{const m=s.match(/rgba?\\(([^)]+)\\)/); if(!m) return null
    const p=m[1].split(',').map(Number); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}}
  const stops=(img)=>{const out=[]; const re=/rgba?\\(([^)]+)\\)/g; let m
    while((m=re.exec(img))){const p=m[1].split(',').map(Number)
      const c={r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; if(c.a>0) out.push(c)}
    return out}
  const over=(f,b)=>({r:f.r*f.a+b.r*(1-f.a), g:f.g*f.a+b.g*(1-f.a), b:f.b*f.a+b.b*(1-f.a), a:1})
  const lum=(c)=>{const f=(v)=>{v/=255; return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)}
    return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)}
  const ratio=(fg,bg)=>{const a=lum(over(fg,bg)), b=lum(bg); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
  const el=document.querySelector(sel); if(!el) return null
  let stack=[], n=el
  while(n){ const st=getComputedStyle(n)
    const g=stops(st.backgroundImage||'')
    if(g.length){ stack.push({grad:g}); if(g.every(c=>c.a===1)) break }
    const c=px(st.backgroundColor); if(c&&c.a>0){ stack.push(c); if(c.a===1) break }
    n=n.parentElement }
  const bodyBg=px(getComputedStyle(document.body).backgroundColor)||{r:255,g:255,b:255,a:1}
  const fg=px(getComputedStyle(el).color)
  const build=(i,acc)=>{ if(i<0) return [acc]
    const L=stack[i]
    if(L.grad) return L.grad.flatMap(c=>build(i-1, over(c,acc)))
    return build(i-1, over(L,acc)) }
  return Math.round(Math.min(...build(stack.length-1, bodyBg).map(bg=>ratio(fg,bg)))*100)/100
}`

const enter = async (mode) => {
  await send('Page.navigate', { url: APP }); await sleep(1600)
  await ev(`localStorage.setItem('bbiyong.dataSource','${mode}')
    localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
    localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
  await send('Page.reload'); await sleep(2600)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  const e1 = mode === 'mock' ? 'safety@bbiyong.io' : 'test@bbiyong.io'
  const p1 = mode === 'mock' ? 'bbiyong' : 'password'
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'${e1}'); s(i[1],'${p1}'); document.querySelector('.auth-submit').click()})()`)
  await sleep(4200)
}
const theme = () => ev(`document.documentElement.getAttribute('data-theme')`)
const setTheme = async (w) => {
  for (let i = 0; i < 3 && (await theme()) !== w; i++) { await ev(`document.querySelector('#nav .theme-btn')?.click()`); await sleep(800) }
  return theme()
}
const tabs = () => ev(`[...document.querySelectorAll('.navtabs button')].map(b=>b.textContent.trim())`)
const goTab = async (name) => {
  await ev(`[...document.querySelectorAll('.navtabs button')].find(b=>b.textContent.trim()===${JSON.stringify(name)})?.click()`)
  await sleep(1200)
}
const box = (sel) => ev(`(()=>{const e=document.querySelector('${sel}'); if(!e) return null
  const r=e.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),
    top:Math.round(r.top),left:Math.round(r.left)}})()`)

await send('Page.enable'); await send('Runtime.enable')
await enter('mock')

console.log('\n[1] 관제가 두 화면으로 나뉘는가')
const tl = await tabs()
console.log('  탭 :', tl.join(' / '))
console.log('  → 지도·카메라 두 탭 :', ok(tl[0] === '지도' && tl[1] === '카메라'))
await goTab('지도')
console.log('  → 지도 화면 :', ok(await ev(`!!document.querySelector('#pgMap')`)))
console.log('  → 좌측에 로봇 상태 :', ok(await ev(`!!document.querySelector('#pgMap .nav-side #pStatus')`)))
console.log('  → 좌측에 이벤트 로그 :', ok(await ev(`!!document.querySelector('#pgMap .nav-side .elog')`)))
console.log('  → 우측에 지도 :', ok(await ev(`!!document.querySelector('#pgMap .nav-canvas #pMap')`)))
const side = await box('#pgMap .nav-side'); const canv = await box('#pgMap .nav-canvas')
console.log('  좌측', side?.w, 'px · 지도', canv?.w, 'px')
console.log('  → 지도가 훨씬 넓다 :', ok(!!canv && !!side && canv.w > side.w * 2))
console.log('  → 조작 패널은 지도 화면에 없다 :', ok(!(await ev(`!!document.querySelector('#pgMap #pControl')`))))

await goTab('카메라')
console.log('  → 카메라 화면 :', ok(await ev(`!!document.querySelector('#pgCam')`)))
const cam = await box('#pgCam #pCam'); const th = await box('#pgCam #pThermal')
const ctl = await box('#pgCam #pControl'); const elog = await box('#pgCam #pEvents')
console.log('  전면', cam?.w, 'x', cam?.h, '· 열화상', th?.w, 'x', th?.h,
  '· 조작', ctl?.w, 'x', ctl?.h, '· 로그', elog?.w, 'x', elog?.h)
// 좌측은 조작(위) + 로그(아래), 우측은 전면 영상 하나. 열화상은 전면 위에 겹쳐 띄운다.
console.log('  → 전면이 우측을 크게 차지 :', ok(!!cam && !!ctl && cam.h > 400 && cam.w > ctl.w * 1.8))
console.log('  → 조작이 좌측 위 :', ok(!!ctl && !!cam && ctl.left + 4 < cam.left))
console.log('  → 로그가 조작 아래 :', ok(!!elog && !!ctl && elog.top > ctl.top + ctl.h - 4))
console.log('  → 열화상이 전면 위에 겹친다 :', ok(!!th && !!cam && th.h > 120
  && th.left >= cam.left && th.left + th.w <= cam.left + cam.w + 2
  && th.top + th.h <= cam.top + cam.h + 2))
console.log('  → 두 영상 모두 캔버스 살아 있음 :', ok(await ev(`(()=>{const c=[...document.querySelectorAll('#pgCam canvas')]
  return c.length===2 && c.every(x=>x.width>0)})()`)))

console.log('\n[2] 화면을 넘치지 않는가 (한눈에 봐야 한다)')
for (const [name, sel] of [['지도', '#pgMap'], ['카메라', '#pgCam']]) {
  await goTab(name)
  const o = await ev(`(()=>{const e=document.querySelector('${sel}')
    return {h:Math.round(e.getBoundingClientRect().height), sh:e.scrollHeight}})()`)
  console.log(`  ${name} : ${o?.h}px · 콘텐츠 ${o?.sh}px`, ok(!!o && o.sh <= o.h + 2))
}

console.log('\n[3] 명료성 — 두 테마 모두 4.5:1 이상')
const MAP_T = [['페이지 제목', '.nav-title h2'], ['KPI 숫자', '.kpi-num'], ['KPI 라벨', '.kpi-label'],
  ['패널 제목', '#pgMap .panel h3'], ['상태 라벨', '#pgMap .kv span'], ['상태 값', '#pgMap .kv b'],
  ['지표 값', '#pgMap .env b'], ['지표 라벨', '#pgMap .env span'], ['로그 본문', '#pgMap .elog li b'],
  ['게이지 값', '#pgMap .rgauge-mid b'], ['상태 알약', '#pgMap .pillm'],
  ['탭(선택)', '#nav.sim-nav .navtabs button.on'], ['탭(비선택)', '#nav.sim-nav .navtabs button:not(.on)']]
// 긴급 정지·순찰 복귀 버튼은 패널에서 걷어냈다 — 잴 대상이 없다.
const CAM_T = [['패널 제목', '#pgCam .panel h3'],
  ['순찰 모드', '#pgCam .seg button.on'], ['각도 라벨', '#pgCam .spdlab span'], ['각도 값', '#pgCam .spdlab b']]
let bad = 0
for (const want of ['light', 'dark']) {
  console.log(`  --- ${await setTheme(want)} ---`)
  await goTab('지도')
  const got = []
  for (const [n, sel] of MAP_T) {
    const v = await ev(`(${CONTRAST})('${sel}')`)
    got.push(`${n} ${v}`)
    if (!(v != null && v >= 4.5)) bad++
  }
  console.log('    ' + got.join(' · '))
  const s1 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `X-map-${want}.png`, Buffer.from(s1.data, 'base64'))
  await goTab('카메라')
  const got2 = []
  for (const [n, sel] of CAM_T) {
    const v = await ev(`(${CONTRAST})('${sel}')`)
    got2.push(`${n} ${v}`)
    if (!(v != null && v >= 4.5)) bad++
  }
  console.log('    ' + got2.join(' · '))
  const s2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `X-cam-${want}.png`, Buffer.from(s2.data, 'base64'))
}
console.log('  → 미달 없음 :', ok(bad === 0), `(미달 ${bad}개)`)
await setTheme('dark')

console.log('\n[4] 안전 조작은 그대로 열려 있는가')
await goTab('카메라')
// 버튼은 걷어냈지만 명령까지 사라지면 안 된다. 무인 시간대에 로봇을 세울 길이
// 하나도 없는 화면이 되기 때문이다 — Shift 단축키가 그 역할을 계속 한다.
console.log('  → 긴급 정지 버튼 없음 :', ok(!(await ev(`!!document.querySelector('#pgCam .dbtn.stop')`))))
const shift = (type) => send('Input.dispatchKeyEvent',
  { type, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 })
await shift('keyDown'); await shift('keyUp'); await sleep(1000)
console.log('  → Shift 로 긴급 정지 :', ok(await ev(`(()=>{
  const pill=document.querySelector('#pgMap .pillm')?.textContent||''
  const log=[...document.querySelectorAll('.elog li')].map(e=>e.textContent).join(' ')
  return /정지/.test(pill) || /정지|ESTOP/i.test(log)})()`)))
console.log('  → 방향 패드 4개 :', ok((await ev(`document.querySelectorAll('#pgCam .dpad button').length`)) === 4))

console.log('\n[5] 실서버 화면은 건드리지 않았는가')
await enter('live')
const tl2 = await tabs()
console.log('  탭 :', tl2.join(' / '))
console.log('  → 관제 한 탭 그대로 :', ok(tl2[0] === '관제' && !tl2.includes('카메라')))
console.log('  → 기존 관제 화면 :', ok(await ev(`!!document.querySelector('#pgB')`)))
console.log('  → navexa 레이어 없음 :', ok(!(await ev(`!!document.querySelector('.nav-page')`))))
console.log('  → 한 화면에 영상·지도·조작 :', ok(await ev(`!!document.querySelector('#pgB #pCam') && !!document.querySelector('#pgB #pMap') && !!document.querySelector('#pgB #pControl')`)))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
