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
  '--remote-debugging-port=9501', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9501/json/list')).json(); if (tg.length) break } catch {}
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
// S15P11E101-749 검증 — 평면 지도 정리
//
// 두 가지를 잰다.
//   1. 평면 뷰에 라이다 스캔점·궤적선이 전혀 없다 (도면만)
//   2. 도면이 캔버스 정중앙에 온다 (확대·회전 후에도)
//
// '안 보인다' 는 캔버스 픽셀로 잰다. 스캔은 청색 점, 궤적은 주황 선이라 색으로 갈린다 —
// 도면은 회색조이므로 채도 있는 픽셀이 남으면 오버레이가 그려진 것이다.
const pose = (x, y, yaw = 0) => be.push('/topic/nav/orinka_01', {
  type: 'NAV_LIVE',
  pose: { x, y, yaw },
  scan: { ranges: Array.from({ length: 180 }, () => 3.0), angle_min: -Math.PI, angle_inc: Math.PI / 90 },
})
const canvas = () => ev(`(()=>{const c=document.querySelector('#pgMap #pMap canvas'); if(!c) return null
  return {w:c.width, h:c.height}})()`)
// 채도 있는 픽셀 수 — 스캔(청)·궤적(주황)이 그려졌는지
// 나침반은 오버레이가 아니라 화면 좌표계의 방향 표시다. 회전 여부와 무관하게 북을
// 알려야 해서 평면 뷰에도 남긴다 — 붉은 바늘이 있는 우상단 모서리는 세지 않는다.
const chroma = () => ev(`(()=>{const c=document.querySelector('#pgMap #pMap canvas'); if(!c) return null
  const g=c.getContext('2d'); const d=g.getImageData(0,0,c.width,c.height).data
  let n=0
  for(let y=0;y<c.height;y++){ for(let x=0;x<c.width;x++){
    if(x > c.width-64 && y < 64) continue          // 나침반 자리
    const i=(y*c.width+x)*4
    const r=d[i],gg=d[i+1],b=d[i+2]
    if(Math.max(r,gg,b)-Math.min(r,gg,b) > 40) n++
  }}
  return n})()`)
// 그려진 것의 무게중심 — 캔버스 중앙과 얼마나 떨어졌나
const centroid = () => ev(`(()=>{const c=document.querySelector('#pgMap #pMap canvas'); if(!c) return null
  const g=c.getContext('2d'); const d=g.getImageData(0,0,c.width,c.height).data
  let sx=0, sy=0, n=0
  for(let y=0;y<c.height;y+=2){ for(let x=0;x<c.width;x+=2){
    const i=(y*c.width+x)*4
    // 배경(#15171c)보다 밝은 픽셀만 — 그려진 것
    if(d[i]>40||d[i+1]>40||d[i+2]>40){ sx+=x; sy+=y; n++ }
  }}
  if(!n) return null
  return {cx:Math.round(sx/n), cy:Math.round(sy/n), w:c.width, h:c.height, n}})()`)

await goTab('지도')
await sleep(1200)
// 실시간 자세·스캔을 흘려 오버레이가 그려질 여지를 만든다
for (let i = 0; i < 6; i++) { pose(3.0 + i * 0.2, 4.2 + i * 0.1, 0.3); await sleep(220) }
await sleep(900)

console.log('\n[1] 평면 뷰에 실시간 오버레이가 없는가')
// 기본은 입체다 — 평면으로 내린다
await ev(`[...document.querySelectorAll('#pgMap .mapview')].find(b=>/입체|평면/.test(b.textContent))?.click()`)
await sleep(1400)
console.log('  평면 전환 :', await ev(`!!document.querySelector('#pgMap #pMap canvas')`))
const ch = await chroma()
console.log('  채도 있는 픽셀 :', ch, '개')
console.log('  → 스캔점·궤적선이 없다 :', ok(ch === 0), '(도면은 회색조라 채도가 남으면 오버레이다)')
console.log('  → 도면은 그려져 있다 :', ok((await centroid())?.n > 0))

console.log('\n[2] 도면이 캔버스 중앙에 오는가')
const c1 = await centroid()
const off1 = c1 && Math.hypot(c1.cx - c1.w / 2, c1.cy - c1.h / 2)
console.log('  무게중심', `(${c1?.cx}, ${c1?.cy})`, '· 캔버스 중앙', `(${Math.round(c1.w / 2)}, ${Math.round(c1.h / 2)})`,
  '· 어긋남', off1?.toFixed(1) + 'px')
console.log('  → 중앙에 있다 :', ok(off1 < Math.min(c1.w, c1.h) * 0.06), '(캔버스 짧은 변의 6% 안)')

console.log('\n[3] 확대해도 중앙을 지키는가')
await ev(`document.querySelector('#pgMap .map-control.zoom-in')?.click()`); await sleep(500)
await ev(`document.querySelector('#pgMap .map-control.zoom-in')?.click()`); await sleep(900)
const c2 = await centroid()
const off2 = c2 && Math.hypot(c2.cx - c2.w / 2, c2.cy - c2.h / 2)
console.log('  확대 후 어긋남 :', off2?.toFixed(1) + 'px')
console.log('  → 중앙 유지 :', ok(off2 < Math.min(c2.w, c2.h) * 0.06))

console.log('\n[4] 입체로 돌아가면 실시간 레이어가 살아나는가')
await ev(`[...document.querySelectorAll('#pgMap .mapview')].find(b=>/입체|평면/.test(b.textContent))?.click()`)
await sleep(1400)
console.log('  → 압출 씬으로 전환 :', ok(await ev(`!!document.querySelector('#pgMap .iso-stage')`)))
console.log('  → 로봇 마커가 있다 :', ok(await ev(`!!document.querySelector('#pgMap .iso-robot')`)),
  '(3D 는 도면 + 마커, 평면은 도면만)')

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M749-plane.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
