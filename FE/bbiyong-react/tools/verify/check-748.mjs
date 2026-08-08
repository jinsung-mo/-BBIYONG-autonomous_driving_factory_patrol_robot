// S15P11E101-745 검증 — 3D 도면 위 로봇 입체 마커
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 로봇이 올바른 셀에 표시되고 yaw 방향이 실제 주행과 일치한다
//   2. 실시간 이동이 부드럽게 반영된다
//
// '부드럽다' 는 눈으로 못 재므로, 값이 튀는지로 잰다. 한 번에 목표로 점프하면
// 중간 프레임이 없다 — 목표를 멀리 옮긴 직후 두 프레임을 떠서, 마커가 아직
// 목표에 닿지 않았고 그러면서 출발점보다는 가까워졌는지를 본다.
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
  '--remote-debugging-port=9497', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9497/json/list')).json(); if (tg.length) break } catch {}
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

const goTab = async (label) => {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${label}')?.click()`)
  await sleep(1200)
}

// S15P11E101-748 검증 — 3D 압출 뷰 비주얼 폴리싱
//
// 스크린샷으로 잡은 네 가지를 값으로 잰다. '어색하다' 는 눈의 판단이지만,
// 그 원인은 숫자로 남는다 — 배경 밝기, 명도 폭, 마스크 유무, 버튼 상태.
const iso = () => ev(`(()=>{
  const st=document.querySelector('.iso-stage'); if(!st) return null
  const px=(v)=>Math.round(parseFloat(v)||0)
  const lum=(c)=>{const p=c.slice(c.indexOf('(')+1,c.indexOf(')')).split(',').map(Number)
    const f=(v)=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}
    return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2])}
  const ss=getComputedStyle(st)
  const floor=document.querySelector('.iso-floor')
  const fs=floor?getComputedStyle(floor):null
  const walls=[...document.querySelectorAll('.iso-wall')].map(w=>getComputedStyle(w).backgroundColor)
  const btn=document.querySelector('.iso-reset')
  const scene=document.querySelector('.iso-scene')
  return {
    bgImage: ss.backgroundImage.slice(0,70),
    // 배경 밝기 — 판이 주변 흰 패널과 같은 편인지
    panelLum: (()=>{const p=document.querySelector('#pgMap .nav-canvas, #pMap'); 
      return p?lum(getComputedStyle(p).backgroundColor||'rgb(255,255,255)'):null})(),
    floorMask: fs? (fs.maskImage||fs.webkitMaskImage||'none') : null,
    floorFilter: fs? fs.filter : null,
    wallCount: walls.length,
    wallFirst: walls[0], wallLast: walls[walls.length-1],
    btn: btn? {cls:btn.className, pressed:btn.getAttribute('aria-pressed'), bg:getComputedStyle(btn).backgroundColor} : null,
    sceneTransition: scene? getComputedStyle(scene).transitionDuration : null,
  }})()`)

const hslLight = (c) => {
  const p = String(c).slice(c.indexOf('(') + 1, c.indexOf(')')).split(',').map(Number)
  return Math.round(((0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255) * 100)
}

await goTab('지도')
await sleep(1200)
let r = await iso()

console.log('\n[1] 배경이 주변 톤과 이어지는가')
console.log('  배경 :', r?.bgImage)
console.log('  → 짙은 남색이 아니다 :', ok(!/#0[0-9a-f]|rgb\(([0-9]|1[0-9]|2[0-9]), /i.test(String(r?.bgImage))
  && /255, 255, 255|244, 245, 248|233, 234, 240/.test(String(r?.bgImage))))

console.log('\n[2] 바닥이 뚝 잘리지 않는가')
console.log('  바닥 마스크 :', String(r?.floorMask).slice(0, 60))
console.log('  → 가장자리를 흘린다 :', ok(/gradient/.test(String(r?.floorMask))), '(잘린 종이처럼 보이지 않게)')
console.log('  바닥 필터 :', r?.floorFilter)
console.log('  → 어둡게 누르지 않는다 :', ok(!/brightness\(0?\.[0-6]/.test(String(r?.floorFilter))))

console.log('\n[3] 벽 명도차가 과하지 않은가')
const lo = hslLight(r?.wallFirst), hi = hslLight(r?.wallLast)
console.log('  벽 층 :', r?.wallCount, '· 아래', lo + '%', '→ 위', hi + '%', '· 폭', Math.abs(hi - lo) + '%')
console.log('  → 명도 폭이 좁다 :', ok(Math.abs(hi - lo) <= 22), '(기둥 하나가 발광체처럼 보이면 안 된다)')
console.log('  → 채도가 낮다 :', ok(await ev(`(()=>{const w=document.querySelector('.iso-wall')
  const c=getComputedStyle(w).backgroundColor
  const p=c.slice(c.indexOf('(')+1,c.indexOf(')')).split(',').map(Number)
  return Math.max(p[0],p[1],p[2]) - Math.min(p[0],p[1],p[2]) <= 24})()`)), '(하늘색이 도면 위에서 튄다)')

console.log('\n[4] 정면으로 버튼이 상태를 말하는가')
console.log('  처음 :', JSON.stringify(r?.btn))
console.log('  → 처음엔 정면 상태 :', ok(r?.btn?.pressed === 'true' && /\bon\b/.test(String(r?.btn?.cls))))
// 드래그로 각도를 틀면 눌림이 풀려야 한다
await ev(`(()=>{const st=document.querySelector('.iso-stage')
  const r=st.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2
  const opt=(x,y)=>({bubbles:true, clientX:x, clientY:y, button:0, pointerId:1})
  st.dispatchEvent(new PointerEvent('pointerdown', opt(cx,cy)))
  st.dispatchEvent(new PointerEvent('pointermove', opt(cx+120,cy)))
  st.dispatchEvent(new PointerEvent('pointerup', opt(cx+120,cy)))})()`)
await sleep(700)
r = await iso()
const offBg = r?.btn?.bg
console.log('  돌린 뒤 :', r?.btn?.pressed)
console.log('  → 각도를 틀면 풀린다 :', ok(r?.btn?.pressed === 'false'))
await ev(`document.querySelector('.iso-reset')?.click()`); await sleep(900)
r = await iso()
console.log('  누른 뒤 :', r?.btn?.pressed, '· 씬 전환 :', r?.sceneTransition)
console.log('  → 다시 정면으로 잠긴다 :', ok(r?.btn?.pressed === 'true'))
// 클래스만 보면 안 된다. 앞선 구현에서 클래스는 붙는데 v3 규칙에 밀려 화면은
// 그대로였다 — 눌린 것과 안 눌린 것의 '칠해진 색' 이 실제로 달라야 한다.
console.log('  눌림 배경 :', r?.btn?.bg, '· 풀림 배경 :', offBg)
console.log('  → 눌림이 색으로 보인다 :', ok(String(r?.btn?.bg) !== String(offBg)))
console.log('  → 각도가 부드럽게 돌아간다 :', ok(parseFloat(r?.sceneTransition) > 0), '(순간이동하면 무엇이 돌았는지 못 본다)')

// [5] 다크 모드 단계는 제거했다 — 다크 모드 자체가 없어졌다(S15P11E101-805).
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M748-iso-light.png', Buffer.from(data, 'base64'))
}

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
