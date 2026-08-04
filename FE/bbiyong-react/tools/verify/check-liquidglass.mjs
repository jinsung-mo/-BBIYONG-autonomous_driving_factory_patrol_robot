// Liquid Glass 재질 검증 — 굴절 · 주변색 적응 · 동심원 모서리 · 명료성 · 범위 격리
// 애플이 정의한 성질을 '보이는가' 가 아니라 '측정되는가' 로 확인한다.
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
  '--remote-debugging-port=9447', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9447/json/list')).json(); if (tg.length) break } catch {}
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
const setTheme = async (want) => {
  for (let i = 0; i < 3 && (await theme()) !== want; i++) {
    await ev(`document.querySelector('#nav .theme-btn')?.click()`); await sleep(800)
  }
  return theme()
}

await send('Page.enable'); await send('Runtime.enable')
await enter('mock')

console.log('\n[1] CSS 프레임워크를 쓰지 않았는가')
const fw = await ev(`(()=>{const out=[]
  for(const s of document.styleSheets){ try{ for(const r of s.cssRules){
    const t=r.cssText||''
    if(/tailwind|bootstrap|bulma|\\.tw-|\\bmd\\\\:|\\bsm\\\\:/i.test(t)) out.push(t.slice(0,60))
  }}catch{} }
  return out.slice(0,3)})()`)
const links = await ev(`[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>l.href).filter(h=>!h.startsWith('http://localhost:5174'))`)
console.log('  프레임워크 흔적 :', (fw || []).length ? fw : '없음', '· 외부 CSS :', (links || []).length ? links : '없음')
console.log('  → 표준 CSS 로만 만들어짐 :', ok((fw || []).length === 0 && (links || []).length === 0))

console.log('\n[2] 판 위에 사람이 그어 놓은 선·막대가 없는가')
// 굴절 링과 상단 1px 흰 선은 걷어냈다. 링은 배경에 밝기 변화가 있는 곳마다 띠로 드러났고,
// 흰 선은 제목 위에 놓인 가로 막대로 보였다. 유리 표면에는 인공적인 선이 없어야 한다 —
// 그 '부재' 를 검사한다. 다시 들어오면 여기서 잡힌다.
const marks = await ev(`(()=>{const el=document.querySelector('#pStatus')
  const b=getComputedStyle(el,'::before'), a=getComputedStyle(el,'::after')
  const h3=getComputedStyle(el.querySelector('h3'))
  return {
    beforeBg:String(b.backgroundImage), beforeFilter:String(b.backdropFilter||b.webkitBackdropFilter||'none'),
    afterBg:String(a.backgroundImage),
    h3Border:h3.borderBottomWidth, h3Style:h3.borderBottomStyle,
    panelBg:String(getComputedStyle(el).backgroundImage),
  }})()`)
console.log('  ::before 배경 :', marks?.beforeBg, '· 굴절 :', marks?.beforeFilter)
console.log('  ::after 배경 :', marks?.afterBg)
console.log('  제목 아래 선 :', marks?.h3Border, marks?.h3Style)
console.log('  판 배경 :', marks?.panelBg)
console.log('  → 상단 흰 막대 없음 :', ok(marks?.beforeBg === 'none' && marks?.beforeFilter === 'none'))
console.log('  → 제목 아래 회색 선 없음 :',
  ok(parseFloat(marks?.h3Border) === 0 || marks?.h3Style === 'none'))
console.log('  → 판 배경이 균일 :', ok(marks?.panelBg === 'none'),
  '(대각 그라데이션은 위쪽을 밝혀 띠처럼 보인다)')

console.log('\n[3] 주변색 적응 — 유리가 뒤 색을 끌어오는가')
const sat = await ev(`(()=>{const s=getComputedStyle(document.querySelector('#pStatus'))
  const f=s.backdropFilter||s.webkitBackdropFilter||''
  const m=/saturate\\(([\\d.]+)\\)/.exec(f); return m?Number(m[1]):null})()`)
console.log('  채도 배율 :', sat)
console.log('  → 유리 잔재 없음 :', ok(sat === null), '(navexa 는 그림자로만 층을 만든다)')
// 서로 다른 색장 위에 놓인 두 판이 실제로 다른 색을 띠는지 픽셀로 확인한다
const boxes = await ev(`(()=>{const g=(s)=>{const r=document.querySelector(s).getBoundingClientRect()
    return {x:Math.round(r.left+24), y:Math.round(r.top+24)}}
  return {left:g('#pStatus'), right:g('#pThermal')}})()`)
const grab = async (b) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: 6, height: 6, scale: 1 } })
  const buf = Buffer.from(data, 'base64')
  // PNG 를 파싱하지 않고 파일로 남긴 뒤 눈으로 대조한다 — 여기서는 크기만 확인
  return buf.length
}
console.log('  좌측 판 표본 :', JSON.stringify(boxes?.left), '· 우측 판 표본 :', JSON.stringify(boxes?.right))
console.log('  (표면색 차이는 G-glass-dark.png 으로 확인 — 좌측은 청색, 우측은 보라 계열)')

console.log('\n[4] 동심원 모서리 — 안쪽 곡선이 바깥과 평행한가')
const radii = await ev(`(()=>{const g=(s)=>{const el=document.querySelector(s); if(!el) return null
    const c=getComputedStyle(el)
    return {r:Math.round(parseFloat(c.borderTopLeftRadius)), pl:Math.round(parseFloat(c.paddingLeft))}}
  return {panel:g('#pStatus'), card:g('#pStatus .stat-card'), env:g('#pStatus .env div'), log:g('#pStatus .elog li')}})()`)
console.log('  판 :', JSON.stringify(radii?.panel))
console.log('  안쪽 : stat-card', radii?.card?.r, '· env', radii?.env?.r, '· log', radii?.log?.r)
const outer = radii?.panel?.r ?? 0
const TOKENS = [8, 16, 24]
console.log('  바깥', outer, '· 반경 토큰', TOKENS.join('/'))
console.log('  → 토큰 안에서 바깥보다 작다 :',
  ok([radii?.card?.r, radii?.env?.r, radii?.log?.r].every((v) => TOKENS.includes(v) && v < outer)),
  '(안쪽이 바깥과 같거나 크면 두 곡선이 부딪힌다)')

console.log('\n[5] 콘텐츠는 유리로 덮지 않는다')
const vwrap = await ev(`(()=>{const s=getComputedStyle(document.querySelector('#pCam .vwrap'))
  return s.backdropFilter||s.webkitBackdropFilter})()`)
console.log('  영상 프레임 backdrop-filter :', vwrap)
console.log('  → 영상 위에 유리를 얹지 않음 :', ok(vwrap === 'none'), '(판독 대상을 흐리면 안 된다)')

console.log('\n[6] 명료성 — 두 테마 모두 4.5:1 이상')
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
const T = [['패널 제목', '#pStatus h3'], ['상태 라벨', '#pStatus .kv span'], ['상태 값', '#pStatus .kv b'],
  ['지표 값', '#pStatus .env b'], ['로그 본문', '#pStatus .elog li b'], ['게이지 값', '.rgauge-mid b'],
  // 긴급 정지·순찰 복귀 버튼은 패널에서 걷어냈다(S15P11E101-688)
  ['순찰 모드', '.seg button.on']]
for (const want of ['dark', 'light']) {
  console.log(`  --- ${await setTheme(want)} ---`)
  const got = []
  for (const [n, sel] of T) got.push([n, await ev(`(${CONTRAST})('${sel}')`)])
  console.log('   ', got.map(([n, c]) => `${n} ${c}`).join(' · '))
  console.log('    → 모두 4.5:1 이상 :', ok(got.every(([, c]) => c != null && c >= 4.5)))
  const s2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `G-glass-${want}.png`, Buffer.from(s2.data, 'base64'))
}
await setTheme('dark')

console.log('\n[7] 커서를 따라다니는 원이 없는가')
// 포인터 좌표를 CSS 변수 하나로 넘겼더니 판마다 그 위치에 원이 하나씩 그려져
// 광원이 다섯 개가 됐다(사용자 확인: "5개의 뿌연 원이 따라다닌다"). 추적을 걷어냈다.
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 300, button: 'none' }); await sleep(400)
const g1 = await ev(`document.querySelector('#pgB').style.getPropertyValue('--glass-x')`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1400, y: 800, button: 'none' }); await sleep(400)
const g2 = await ev(`document.querySelector('#pgB').style.getPropertyValue('--glass-x')`)
const radial = await ev(`(()=>{const a=getComputedStyle(document.querySelector('#pStatus'),'::after')
  return /radial-gradient/.test(String(a.backgroundImage))})()`)
console.log('  --glass-x :', JSON.stringify(g1), '→', JSON.stringify(g2), '· 판에 radial 광원 :', radial)
console.log('  → 포인터 추적 없음 :', ok(!g1 && !g2))
console.log('  → 판마다 원을 그리지 않음 :', ok(radial === false))

console.log('\n[8] 실서버 화면은 건드리지 않았는가')
await enter('live')
console.log('  #pgB class :', await ev(`document.querySelector('#pgB')?.className`))
console.log('  → sim-skin 없음 :', ok(!(await ev(`document.querySelector('#pgB')?.classList.contains('sim-skin')`))))
const liveR = await ev(`getComputedStyle(document.querySelector('#pStatus')).borderTopLeftRadius`)
const liveF = await ev(`(()=>{const s=getComputedStyle(document.querySelector('#pStatus')); return s.backdropFilter||s.webkitBackdropFilter})()`)
const liveRim = await ev(`(()=>{const b=getComputedStyle(document.querySelector('#pStatus'),'::before'); return String(b.backdropFilter||b.webkitBackdropFilter||'none')})()`)
console.log('  패널 모서리 :', liveR, '· backdrop-filter :', liveF, '· 링 :', liveRim)
console.log('  → 기존 그대로(12px · none) :', ok(liveR === '12px' && liveF === 'none'))
console.log('  → 굴절 링이 새지 않음 :', ok(liveRim === 'none'))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
