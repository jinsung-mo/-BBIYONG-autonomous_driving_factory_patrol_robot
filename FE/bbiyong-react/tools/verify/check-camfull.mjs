// 전면 카메라 확대 + 열화상 동시 표시 검증
// 캔버스가 '살아 있는가' 까지 본다 — 자리를 옮기다 프레임이 끊기면 정지 화면을 크게 보게 된다.
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
  '--remote-debugging-port=9463', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9463/json/list')).json(); if (tg.length) break } catch {}
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
    localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')
    sessionStorage.removeItem('bbiyong.fireAlarm')`)
  await send('Page.reload'); await sleep(2600)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  const e1 = mode === 'mock' ? 'safety@bbiyong.io' : 'test@bbiyong.io'
  const p1 = mode === 'mock' ? 'bbiyong' : 'password'
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'${e1}'); s(i[1],'${p1}'); document.querySelector('.auth-submit').click()})()`)
  await sleep(4200)
}
// 진짜 더블클릭. 첫 클릭 clickCount 1, 두 번째 2 여야 dblclick 이 한 번만 난다.
const dblClick = async (sel) => {
  const c = await ev(`(()=>{const e=document.querySelector('${sel}'); if(!e) return null
    const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}})()`)
  if (!c) return false
  for (const [t, n] of [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]) {
    await send('Input.dispatchMouseEvent', { type: t, x: c.x, y: c.y, button: 'left', clickCount: n })
  }
  await sleep(900)
  return true
}
const full = () => ev(`document.querySelector('#pgB')?.classList.contains('cam-full')`)
const box = (sel) => ev(`(()=>{const e=document.querySelector('${sel}'); if(!e) return null
  const r=e.getBoundingClientRect(); const s=getComputedStyle(e)
  return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
          vis:s.visibility, z:s.zIndex, pos:s.position}})()`)
// 캔버스가 실제로 갱신되는지 — 두 시점의 픽셀 데이터를 비교한다
const canvasLive = async (sel) => {
  // 표본은 가운데에서 넓게 뜬다. 좌상단 구석은 천장뿐이라 로봇이 움직여도 값이 그대로다 —
  // 처음에 그 구석을 재서 '정지' 로 잘못 읽었다. 합계로 비교해 미세한 변화도 잡는다.
  const grab = `(()=>{const c=document.querySelector('${sel}'); if(!c||!c.width) return null
    const w=Math.min(200,c.width), h=Math.min(200,c.height)
    const d=c.getContext('2d').getImageData(Math.round(c.width/2-w/2),Math.round(c.height/2-h/2),w,h).data
    let sum=0; for(let i=0;i<d.length;i+=4) sum+=d[i]+d[i+1]+d[i+2]
    return sum})()`
  const a = await ev(grab)
  await sleep(1400)
  const b = await ev(grab)
  return { changed: a != null && b != null && a !== b, a, b }
}

await send('Page.enable'); await send('Runtime.enable')

for (const mode of ['mock', 'live']) {
  console.log(`\n===== ${mode === 'mock' ? '시뮬레이션' : '실서버'} 모드 =====`)
  await enter(mode)
  const before = await box('#pCam')
  console.log('  평소 카메라 판 :', JSON.stringify(before))
  console.log('  → 평소엔 확대 아님 :', ok((await full()) === false))

  console.log('\n  [1] 더블클릭하면 전체 화면이 되는가')
  await dblClick('#pCam .vwrap')
  console.log('    → 확대 상태 :', ok(await full()))
  const cam = await box('#pCam')
  const vw = await ev(`({w:innerWidth,h:innerHeight})`)
  console.log('    카메라 판 :', JSON.stringify(cam))
  console.log('    → 화면을 채운다 :',
    ok(cam?.pos === 'fixed' && cam.w > vw.w * 0.9 && cam.h > vw.h * 0.9),
    `(창 ${vw.w}×${vw.h})`)

  console.log('\n  [2] 열화상이 우측 아래에 함께 뜨는가')
  const th = await box('#pThermal')
  console.log('    열화상 판 :', JSON.stringify(th))
  const rightBottom = th && th.x > vw.w * 0.55 && th.y > vw.h * 0.4
  const smaller = th && cam && th.w < cam.w * 0.5
  console.log('    → 보인다 :', ok(th?.vis === 'visible'))
  console.log('    → 우측 아래에 있다 :', ok(rightBottom))
  console.log('    → 전면보다 작다 :', ok(smaller), th && cam ? `(${th.w} vs ${cam.w})` : '')
  console.log('    → 전면 영상 위에 있다 :', ok(Number(th?.z) >= Number(cam?.z)))
  const overlap = await ev(`(()=>{const t=document.querySelector('#pThermal').getBoundingClientRect()
    const el=document.elementFromPoint(Math.round(t.left+t.width/2), Math.round(t.top+t.height/2))
    const th=document.querySelector('#pThermal')
    return el===th||th.contains(el)})()`)
  console.log('    → 가려지지 않는다 :', ok(overlap))

  console.log('\n  [3] 두 영상이 모두 살아 있는가 (정지 화면을 크게 보면 안 된다)')
  const camLive = await canvasLive('#pCam canvas')
  const thLive = await canvasLive('#pThermal canvas')
  console.log('    → 전면 갱신 :', ok(camLive.changed), `(${camLive.a} → ${camLive.b})`)
  console.log('    → 열화상 갱신 :', ok(thLive.changed), `(${thLive.a} → ${thLive.b})`)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `C-camfull-${mode}.png`, Buffer.from(shot.data, 'base64'))

  console.log('\n  [4] 확대 중에도 경보는 보여야 한다')
  if (mode === 'live') {
    be.push('/topic/alerts', { type: 'FIRE', level: 'CRITICAL', robotId: 'orinka_01', confidence: 0.9, timestamp: new Date().toISOString() })
    await sleep(1400)
    const fz = await ev(`(()=>{const f=document.querySelector('.fireflash'); if(!f) return null
      return {z:Number(getComputedStyle(f).zIndex), camz:Number(getComputedStyle(document.querySelector('#pCam')).zIndex)}})()`)
    console.log('    화재 점멸 z :', fz?.z, '· 카메라 z :', fz?.camz)
    console.log('    → 화재 점멸이 위 :', ok(fz && fz.z > fz.camz))
    const ackHit = await ev(`(()=>{const b=document.querySelector('#btnFireAck'); if(!b) return false
      const r=b.getBoundingClientRect(); const el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2))
      return el===b||b.contains(el)})()`)
    console.log('    → 확인 버튼이 눌린다 :', ok(ackHit))
    await ev(`document.querySelector('#btnFireAck')?.click()`); await sleep(600)
  } else {
    console.log('    (실서버 모드에서 확인)')
  }

  console.log('\n  [5] 나가는 길')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(700)
  console.log('    → ESC 로 닫힌다 :', ok((await full()) === false))
  await dblClick('#pCam .vwrap')
  console.log('    다시 확대 :', await full())
  const x = await ev(`(()=>{const b=document.querySelector('#btnCamFullExit'); if(!b) return null
    const r=b.getBoundingClientRect(); const el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2))
    return {reachable: el===b||b.contains(el)}})()`)
  console.log('    → 닫기 버튼이 눌린다 :', ok(x?.reachable))
  await ev(`document.querySelector('#btnCamFullExit')?.click()`); await sleep(600)
  console.log('    → 버튼으로 닫힌다 :', ok((await full()) === false))
  await dblClick('#pCam .vwrap'); await dblClick('#pCam .vwrap')
  console.log('    → 다시 더블클릭하면 원래대로 :', ok((await full()) === false))
  const after = await box('#pCam')
  console.log('    닫은 뒤 판 :', JSON.stringify(after))
  console.log('    → 자리로 돌아온다 :', ok(after?.pos === before?.pos && Math.abs(after.w - before.w) < 4))
  console.log('    → 다른 판도 되살아난다 :',
    ok((await box('#pStatus'))?.vis === 'visible' && (await box('#pMap'))?.vis === 'visible'))
}

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
