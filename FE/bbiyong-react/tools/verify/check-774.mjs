// S15P11E101-765 검증 — 이벤트 로그 클릭 → 상세·영상(±15초) 모달
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 이벤트 탭·지도 사이드 로그 모두에서 행을 클릭하면 상세 모달이 뜨고 영상이 붙는다
//   2. 실시간으로 막 수신된 경보 행도 클릭 가능하다
//
// 이 티켓의 회귀 원인 후보는 둘이었다 — 배포 빌드가 구버전이거나, 실시간 수신분에서
// eventId 가 유실되어 행이 비클릭 텍스트로 렌더되거나. 여기서는 후자를 값으로 가른다.
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
  '--remote-debugging-port=9529', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9529/json/list')).json(); if (tg.length) break } catch {}
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
  await sleep(1400)
}
// S15P11E101-774 검증 — 맵 목록 도면/원본 구분
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 기본 목록에 도면만 보이고 원본은 토글로 확인 가능하다
//   2. 항목 종류가 뱃지로 구분된다
const rows = () => ev(`[...document.querySelectorAll('#pgOps .map-list li')].map(li=>({
  name:(li.querySelector('b')?.textContent||'').trim(),
  kind:(li.querySelector('.tag.kind')?.textContent||'').trim(),
  cls:li.className,
  src:(li.querySelector('.t.src')?.textContent||'').trim()}))`)

// 매핑 한 번 = 원본 + 도면 두 건. 두 번 돌린 상황을 만든다.
be.addMap('factory_02', 'FLOORPLAN', 'm-raw-2')
be.addMap('factory_02_raw', 'RAW')
be.addMap('factory_01', 'FLOORPLAN', 'm-raw-1')
be.addMap('factory_01_raw', 'RAW')

await goTab('운영')
await ev(`[...document.querySelectorAll('#pgOps button')].find(b=>/목록 새로고침/.test(b.textContent))?.click()`)
await sleep(1800)

console.log('\n[1] 기본은 도면만 보이는가')
let r = await rows()
console.log('  행 :', JSON.stringify(r))
console.log('  → 도면만 나온다 :', ok(r.length === 2 && r.every((x) => x.kind === '도면')),
  '(매핑 한 번에 두 건씩 쌓여 목록이 금세 지저분해진다)')
console.log('  → 원본은 감춰져 있다 :', ok(!r.some((x) => /_raw/.test(x.name))))

console.log('\n[2] 종류가 뱃지로 구분되는가')
console.log('  → 도면 뱃지 :', ok(r.every((x) => x.kind === '도면')))
console.log('  → 항목에 종류 클래스가 붙는다 :', ok(r.every((x) => /plan/.test(x.cls))))
console.log('  원본 연결 :', r[0]?.src)
console.log('  → 어느 원본에서 나왔는지 알린다 :', ok(/원본/.test(String(r[0]?.src))))

console.log('\n[3] 토글로 원본을 꺼낼 수 있는가')
await ev(`document.querySelector('#btnToggleRaw')?.click()`)
await sleep(900)
r = await rows()
console.log('  행 :', r.map((x) => `${x.name}(${x.kind})`).join(' · '))
console.log('  → 원본이 함께 나온다 :', ok(r.length === 4 && r.some((x) => x.kind === '원본')))
console.log('  → 원본 뱃지가 다르다 :', ok(r.some((x) => x.kind === '원본' && /raw/.test(x.cls))))
await ev(`document.querySelector('#btnToggleRaw')?.click()`)
await sleep(900)
console.log('  → 다시 접으면 도면만 :', ok((await rows()).length === 2))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'M774-maplist.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
