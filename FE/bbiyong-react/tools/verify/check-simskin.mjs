// 시뮬레이션 화면 스킨 검증 — 적용 범위 · 새 요소 · 조작 유지 · 두 테마 대비
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
  '--remote-debugging-port=9435', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9435/json/list')).json(); if (tg.length) break } catch {}
  await sleep(500)
}
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value ?? '').join(' '))
}
const send = (me, pa = {}) => new Promise((r) => { const i = ++id; pending.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value

// 배경이 반투명이면 뒤에 깔린 색과 섞어야 실제로 보이는 색이 나온다.
// 조상들을 올라가며 불투명한 배경을 만날 때까지 합성한 뒤 명도대비를 잰다.
//
// backgroundColor 만 보면 안 된다 — 그라데이션은 background-image 로 들어가고
// backgroundColor 는 투명으로 남는다. 그대로 두면 파란 알약 위의 흰 글자를
// '흰 패널 위의 흰 글자'로 잘못 재고 지나간다(실제로 한 번 놓쳤다).
// 그라데이션은 색 정지점을 모두 뽑아 각각 재고 가장 나쁜 값을 답으로 삼는다.
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
  const ratio=(fg,bg)=>{const a=lum(over(fg,bg)), b=lum(bg)
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
  const el=document.querySelector(sel); if(!el) return null
  // 자기 자신부터 위로 올라가며 불투명한 바탕을 만들어 둔다
  let stack=[], n=el
  while(n){ const st=getComputedStyle(n)
    const g=stops(st.backgroundImage||'')
    if(g.length){ stack.push({grad:g}); if(g.every(c=>c.a===1)) break }
    const c=px(st.backgroundColor); if(c&&c.a>0){ stack.push(c); if(c.a===1) break }
    n=n.parentElement }
  const bodyBg=px(getComputedStyle(document.body).backgroundColor)||{r:255,g:255,b:255,a:1}
  const fg=px(getComputedStyle(el).color)
  // 그라데이션이 섞여 있으면 정지점 조합마다 재고 최악을 취한다
  const build=(i,acc)=>{ if(i<0) return [acc]
    const layer=stack[i]
    if(layer.grad) return layer.grad.flatMap(c=>build(i-1, over(c,acc)))
    return build(i-1, over(layer,acc)) }
  const worst=Math.min(...build(stack.length-1, bodyBg).map(bg=>ratio(fg,bg)))
  return Math.round(worst*100)/100
}`

const login = async (mode) => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input');
    s(i[0],${JSON.stringify('mock')}===${JSON.stringify(mode)}?'safety@bbiyong.io':'test@bbiyong.io');
    s(i[1],${JSON.stringify('mock')}===${JSON.stringify(mode)}?'bbiyong':'password');
    document.querySelector('.auth-submit').click()})()`)
  await sleep(4000)
}
const enter = async (mode) => {
  await send('Page.navigate', { url: APP }); await sleep(1600)
  // 모드를 바꿀 때는 이전 세션을 버린다 — mock 로그인은 로컬이라 그대로 두면
  // live 로 들어가도 서버 토큰이 없어 대시보드 조회가 시작되지 않는다.
  await ev(`localStorage.setItem('bbiyong.dataSource','${mode}'); sessionStorage.removeItem('bbiyong.fireAlarm')
    localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')`)
  await send('Page.reload'); await sleep(2600)
  await login(mode)
}
const theme = () => ev(`document.documentElement.getAttribute('data-theme')`)
const setTheme = async (want) => {
  for (let i = 0; i < 3 && (await theme()) !== want; i++) {
    await ev(`[...document.querySelectorAll('#nav .theme-btn')][0]?.click()`); await sleep(800)
  }
  return theme()
}

await send('Page.enable'); await send('Runtime.enable')
await enter('mock')

// 긴급 정지·순찰 복귀 버튼은 조작 패널에서 걷어냈다(S15P11E101-688).
// 명령은 Shift 단축키로 남아 있다 — 한 번 누르면 정지, 다시 누르면 순찰 복귀 토글이다.
const shiftTap = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft',
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 })
  }
}

console.log('\n[1] 스킨이 시뮬레이션 화면에만 붙는가')
console.log('  #pgB class :', await ev(`document.querySelector('#pgB')?.className`))
// 시뮬 관제는 지도·카메라 두 화면으로 나뉘었다. #pgB 는 실서버 전용이 됐다.
console.log('  → 시뮬에 sim-skin :', ok(await ev(`[...document.querySelectorAll('#pgMap,#pgCam')].length>0
  && [...document.querySelectorAll('#pgMap,#pgCam')].every(e=>e.classList.contains('sim-skin'))`)))

console.log('\n[2] 대표 지표 게이지')
console.log('  게이지 :', await ev(`document.querySelector('.rgauge')?.getAttribute('class')`))
console.log('  가운데 값 :', await ev(`document.querySelector('.rgauge-mid b')?.textContent`))
console.log('  → 게이지 노출 :', ok(await ev(`!!document.querySelector('.rgauge svg')`)))
console.log('  → 배터리 막대는 대체됨 :', ok(!(await ev(`!!document.querySelector('#pStatus .bar')`))))
const aria = await ev(`document.querySelector('.rgauge svg')?.getAttribute('aria-label')`)
console.log('  → 스크린리더 값 :', ok(!!aria && /배터리/.test(aria)), `(${aria})`)
// 눈금이 값에 따라 실제로 움직이는지 — 고정 그림이면 게이지가 아니다
const dash = await ev(`document.querySelector('.rgauge-fill')?.getAttribute('stroke-dasharray')`)
const batt = await ev(`Number(document.querySelector('.rgauge-mid b')?.textContent?.replace(/[^0-9]/g,''))`)
const filled = Number(String(dash).split(' ')[0])
const expect = 2 * Math.PI * 52 * 0.75 * (batt / 100)
console.log(`  호 길이 :${filled?.toFixed(1)} · 값 ${batt}% 기대 ${expect.toFixed(1)}`)
console.log('  → 값과 눈금이 일치 :', ok(Math.abs(filled - expect) < 1))

// 지표는 상태 패널 안의 3칸에서 화면 맨 위 KPI 행으로 올라갔다(S15P11E101-691).
// 멀리서 읽어야 하는 값이라 패널 안에 묻어 두지 않는다.
console.log('\n[3] 지표 - 화면 위 KPI 행')
const env = await ev(`[...document.querySelectorAll('#pgMap .kpis .kpi')].map(d=>
  d.querySelector('.kpi-label').textContent+'='+d.querySelector('.kpi-num').textContent)`)
console.log('  KPI :', (env || []).join(' / '))
console.log('  → 네 칸 :', ok((env || []).length === 4))
console.log('  → 경보 이벤트 포함 :', ok((env || []).some((e) => e.startsWith('경보 이벤트'))))
console.log('  → 최고 온도 포함 :', ok((env || []).some((e) => e.startsWith('최고 온도'))))
// 평소에 붉은 배지가 상주하면 정작 경보가 났을 때 눈에 들어오지 않는다
console.log('  → 평소엔 강조 없음 :', ok(!(await ev(`!!document.querySelector('#pgMap .kpis .kpi-badge.bad')`))))
const { data: s1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'S-sim-dark.png', Buffer.from(s1, 'base64'))

console.log('\n[4] 조작이 그대로 되는가')
const before = await ev(`document.querySelector('#pStatus .kv b.st')?.textContent?.trim()`)
await shiftTap(); await sleep(900)
const after = await ev(`document.querySelector('#pStatus .kv b.st')?.textContent?.trim()`)
console.log('  E-STOP :', before, '→', after)
// S15P11E101-735 · 762 — 긴급 정지 수단은 의도적으로 전부 제거했다(버튼 688, 단축키 735).
// 그러니 여기서 잴 것은 '나가는가' 가 아니라 '없는 상태가 지켜지는가' 다.
// 되살리면 이 단언이 실패해 알려 준다 — 지금까지는 지워진 채 아무도 지키지 않았다.
console.log('  → Shift 로 정지되지 않는다 :', ok(!/체결/.test(String(after))))
await shiftTap(); await sleep(900)
console.log('  → Shift 로 복귀되지도 않는다 :', ok(!/체결/.test(String(await ev(`document.querySelector('#pStatus .kv b.st')?.textContent`)))))
await ev(`[...document.querySelectorAll('.seg button')][1]?.click()`); await sleep(600)
console.log('  → 수동 모드 전환 :', ok(await ev(`[...document.querySelectorAll('.seg button')][1]?.classList.contains('on')`)))
await ev(`[...document.querySelectorAll('.seg button')][0]?.click()`); await sleep(500)
console.log('  → 방향 패드 4개 :', ok((await ev(`document.querySelectorAll('.dpad button').length`)) === 4))

console.log('\n[5] 두 테마 모두에서 글자가 읽히는가')
// 유리판은 뒤 배경까지 비친다 — 실제로 칠해지는 색으로 재야 한다.
// 그라데이션은 정지점마다 재고 가장 나쁜 값을 취한다(CONTRAST 참고).
const TARGETS = [
  ['순찰 모드', '.seg button.on'],
  ['게이지 값', '.rgauge-mid b'],
  ['상태 라벨', '#pStatus .kv span'],
  ['지표 값', '#pgMap .kpi-num'], ['지표 라벨', '#pgMap .kpi-label'],
  ['로그 본문', '#pStatus .elog li b'],
]
for (const want of ['dark', 'light']) {
  console.log(`  --- ${await setTheme(want)} ---`)
  const got = []
  for (const [name, sel] of TARGETS) got.push([name, await ev(`(${CONTRAST})('${sel}')`)])
  console.log('   ', got.map(([n, c]) => `${n} ${c}`).join(' · '))
  console.log('    → 모두 4.5:1 이상 :', ok(got.every(([, c]) => c != null && c >= 4.5)), '(WCAG AA 본문 기준)')
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `S-sim-${want}.png`, Buffer.from(data, 'base64'))
}
console.log('  테마 복귀 :', await setTheme('dark'))

console.log('\n[5-b] 커서를 따라다니는 원이 없는가')
// 포인터 좌표를 CSS 변수로 넘겨 스펙큘러를 움직이게 했었다. 그런데 그 변수를 판마다
// 읽으므로 판 수만큼 원이 생겨 광원이 다섯 개가 됐다 — 유리가 아니라 얼룩이었다.
// 추적 자체를 걷어냈으니, 이제는 '따라오지 않는 것' 이 정답이다.
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 500, button: 'none' })
await sleep(500)
const gx1 = await ev(`document.querySelector('#pgB')?.style.getPropertyValue('--glass-x')`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 300, button: 'none' })
await sleep(500)
const gx2 = await ev(`document.querySelector('#pgB')?.style.getPropertyValue('--glass-x')`)
console.log('  --glass-x :', JSON.stringify(gx1), '→', JSON.stringify(gx2))
console.log('  → 포인터 추적 없음 :', ok(!gx1 && !gx2))
const anyRadial = await ev(`[...document.querySelectorAll('#pgB .panel')].some(el=>
  /radial-gradient/.test(String(getComputedStyle(el,'::after').backgroundImage)))`)
console.log('  → 판마다 원을 그리지 않음 :', ok(anyRadial === false))

console.log('\n[6] 좁은 창에서 지표 카드가 잘리지 않는가')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(700)
const overflow = await ev(`[...document.querySelectorAll('#pgMap .kpis .kpi-num,#pgMap .kpis .kpi-label')].some(b=>b.scrollWidth>b.clientWidth+1)`)
// KPI 행이 화면 밖으로 밀려나면 값이 있어도 못 본다 — 줄바꿈이든 축소든 안에 들어와야 한다
const fits = await ev(`(()=>{const k=document.querySelector('#pgMap .kpis'); if(!k) return null
  const hero=k.parentElement.getBoundingClientRect(); const r=k.getBoundingClientRect()
  return r.right <= hero.right + 1 && k.scrollWidth <= k.clientWidth + 1})()`)
console.log('  1280px · 숫자 잘림 :', overflow, '· 행이 안에 들어옴 :', fits)
console.log('  → 화면 안에 들어온다 :', ok(fits === true))
console.log('  → 값이 잘리지 않음 :', ok(!overflow))
await send('Emulation.clearDeviceMetricsOverride'); await sleep(500)

console.log('\n[7] 실서버 화면도 같은 규격인가')
await enter('live')
// 관제는 지도·카메라 두 화면으로 나뉘었다(S15P11E101-688). #pgB 는 더 이상 없다.
console.log('  화면 :', await ev(`[...document.querySelectorAll('.page.on')].map(e=>e.id).join(' / ')`))
console.log('  → 지도 화면이 뜬다 :', ok(await ev(`!!document.querySelector('#pgMap')`)))
console.log('  → 게이지 없음 :', ok(!(await ev(`!!document.querySelector('#pgMap .rgauge')`))), '(실서버는 막대로 본다)')
console.log('  → 배터리 막대 유지 :', ok(await ev(`!!document.querySelector('#pgMap #pStatus .bar')`)))
// S15P11E101-757 에서 실서버 화면도 v3 톤으로 통일했다. '시뮬 스킨이 새지 않는다' 는
// 전제가 사라졌으므로, 이제 잴 것은 두 화면이 같은 카드 규격을 쓰는가다.
const radius = await ev(`getComputedStyle(document.querySelector('#pgMap #pStatus')).borderRadius`)
console.log('  패널 모서리 :', radius)
console.log('  → v3 카드 규격(16px) :', ok(radius === '16px'), '(화면마다 다른 층이 생기지 않는다)')

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
