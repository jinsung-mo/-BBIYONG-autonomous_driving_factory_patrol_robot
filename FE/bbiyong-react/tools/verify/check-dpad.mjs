// 방향 패드 눌림 표시 검증 — WASD 를 실제로 눌러 '보이는가' 를 잰다.
// 색만으로 판단하지 않는다: 배경 · 글자색 · 눌림 그림자 · 축소가 모두 바뀌어야 한다.
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
  '--remote-debugging-port=9455', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9455/json/list')).json(); if (tg.length) break } catch {}
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

// 방향 버튼 하나의 '보이는 상태'를 통째로 뜬다
const STATE = `(()=>{const b=[...document.querySelectorAll('.dpad button')][0]
  const s=getComputedStyle(b)
  return {cls:b.className, bgImg:String(s.backgroundImage), bgCol:s.backgroundColor,
          color:s.color, shadow:String(s.boxShadow).slice(0,120), transform:s.transform,
          disabled:b.disabled}})()`

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','mock')
  localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
  localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'safety@bbiyong.io'); s(i[1],'bbiyong'); document.querySelector('.auth-submit').click()})()`)
await sleep(4200)

// 주행은 수동 모드에서만 먹는다 — 순찰 중이면 방향 버튼이 잠겨 있다
const goCam = async () => {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='카메라')?.click()`)
  await sleep(500)
}
const goManual = async () => {
  await goCam()
  await ev(`(()=>{const b=[...document.querySelectorAll('.seg button')]; if(b[1] && !b[1].classList.contains('on')) b[1].click()})()`)
  await sleep(700)
}
const key = async (type, k) => send('Input.dispatchKeyEvent', {
  type, key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  nativeVirtualKeyCode: k.toUpperCase().charCodeAt(0), text: type === 'keyDown' ? k : undefined,
})

// 테마는 라이트 하나다 — 다크 모드는 걷어냈다(S15P11E101-805).
for (const want of ['light']) {
  console.log(`\n===== ${want} =====`)
  await goManual()
  const idle = await ev(STATE)
  console.log('  평소 :', idle?.disabled ? '(잠김 — 수동 모드 아님)' : '')
  console.log('    배경', idle?.bgImg?.slice(0, 54), '· 글자', idle?.color, '· 변형', idle?.transform)
  console.log('  → 조작 가능 :', ok(idle?.disabled === false), '(잠겨 있으면 눌림을 잴 수 없다)')
  await key('keyDown', 'w'); await sleep(400)
  const down = await ev(STATE)
  const pressedContrast = await ev(`(${CONTRAST})('.dpad button.active')`)
  console.log('  W 누름 :')
  console.log('    클래스', JSON.stringify(down?.cls), '· 배경', down?.bgImg?.slice(0, 54))
  console.log('    글자', down?.color, '· 변형', down?.transform)
  console.log('    그림자', down?.shadow?.slice(0, 80))
  // S15P11E101-691 부터 눌림은 색을 바꾸지 않는다. 색이 튀면 판이 번쩍이는 것처럼 보여
  // 영상 옆에서 계속 보고 있기 어렵다 — 대신 그림자와 눌려 들어가는 형태로 알린다.
  const colorHeld = down?.bgImg === idle?.bgImg && down?.color === idle?.color
  const scaled = down?.transform !== idle?.transform && down?.transform !== 'none'
  const inset = /inset/.test(String(down?.shadow))
  console.log('  → 클래스가 붙는다 :', ok(String(down?.cls).includes('active')))
  console.log('  → 색은 고정된다 :', ok(colorHeld), '(번쩍임 없이 형태로만 알린다)')
  console.log('  → 눌려 들어간다 :', ok(inset && scaled), '(그림자와 축소 — 색 말고 형태로도 알린다)')
  console.log('  → 눌린 글자 대비 :', pressedContrast, ok(pressedContrast >= 4.5))
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `D-dpad-${want}.png`, Buffer.from(data, 'base64'))

  await key('keyUp', 'w'); await sleep(400)
  const up = await ev(STATE)
  console.log('  → 떼면 원래대로 :', ok(up?.bgImg === idle?.bgImg && up?.color === idle?.color))
}

console.log('\n[움직임 줄이기] 축소는 꺼도 채움은 남아야 한다')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await sleep(300)
await key('keyDown', 'w'); await sleep(400)
const rm = await ev(STATE)
console.log('  변형 :', rm?.transform, '· 배경 :', rm?.bgImg?.slice(0, 44))
console.log('  → 축소 없음 :', ok(rm?.transform === 'none'))
console.log('  → 채움은 유지 :', ok(/gradient/.test(String(rm?.bgImg))), '(사라지면 어느 방향이 먹는지 알 수 없다)')
await key('keyUp', 'w')
await send('Emulation.setEmulatedMedia', { features: [] })

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 3) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
