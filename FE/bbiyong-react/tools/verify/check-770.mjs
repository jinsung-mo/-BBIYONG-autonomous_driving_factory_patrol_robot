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
  '--remote-debugging-port=9525', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9525/json/list')).json(); if (tg.length) break } catch {}
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
// S15P11E101-770 검증 — 위치 구역명 전환 + 구역 편집
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 좌표 원문이 기본 노출되지 않고 구역/랜드마크 라벨로 표시된다
//   2. 관리자가 구역 이름을 바꾸면 즉시 반영된다
const pose = (x, y) => be.push('/topic/robots', {
  type: 'TELEMETRY', robotId: 'orinka_01', online: true, status: 'PATROL',
  battery: 80, location: { x, y, yaw: 0 },
})
const locText = () => ev(`(()=>{const kv=[...document.querySelectorAll('#pgMap #pStatus .kv')]
  .find(k=>/위치/.test(k.querySelector('span')?.textContent||''))
  if(!kv) return null
  const b=kv.querySelector('b')
  return {text:(b?.textContent||'').trim(), title:b?.getAttribute('title')||''}})()`)
const zoneRows = () => ev(`[...document.querySelectorAll('#pZones .zone-list li')].map(li=>({
  name:li.querySelector('.zone-name')?.value, rect:(li.querySelector('.zone-rect')?.textContent||'').trim()}))`)

console.log('\n[1] 구역이 없으면 좌표로라도 말하는가')
await goTab('지도')
pose(1.0, 1.0)
await sleep(1600)
let L = await locText()
console.log('  위치 :', JSON.stringify(L))
console.log('  → 값이 뜬다 :', ok(!!L?.text && L.text !== '—'))
console.log('  → 원좌표는 툴팁에 남는다 :', ok(/1\.00, 1\.00 m/.test(String(L?.title))),
  '(정합을 의심할 때 확인할 곳은 있어야 한다)')

console.log('\n[2] 관리자가 격자를 만들 수 있는가')
await goTab('설정')
await ev(`document.querySelector('#btnSeedZones')?.click()`)
await sleep(2000)
let rows = await zoneRows()
console.log('  구역 :', rows?.length, '개 ·', rows?.[0]?.name, '·', rows?.[0]?.rect)
console.log('  → 3×3 이 생긴다 :', ok(rows?.length === 9))
console.log('  → 좌표는 읽기 전용으로 보인다 :', ok(/~/.test(String(rows?.[0]?.rect)) && /m$/.test(String(rows?.[0]?.rect))))
const seedCall = be.restCalls.find((c) => c.url.startsWith('/api/zones/seed-grid'))
console.log('  → 서버가 만든다 :', ok(!!seedCall), `(${seedCall?.url || '호출 없음'})`)

console.log('\n[3] 좌표가 구역 이름으로 바뀌는가')
await goTab('지도')
pose(1.0, 1.0)
await sleep(1800)
L = await locText()
console.log('  위치 :', JSON.stringify(L))
console.log('  → 구역 이름이 나온다 :', ok(/구역 [A-C][1-3]/.test(String(L?.text))))
console.log('  → 좌표 원문이 본문에 없다 :', ok(!/[0-9]+\.[0-9]{2}, /.test(String(L?.text))),
  '(좌표는 툴팁으로만)')

console.log('\n[4] 이름을 바꾸면 즉시 반영되는가')
await goTab('설정')
// 값 입력과 blur 를 붙여 쏘면 React 가 상태를 반영하기 전에 onBlur 가 돌아,
// 바뀌지 않은 이름으로 읽고 저장을 건너뛴다 — 사람 손보다 빠른 것이 문제다.
// 값을 주입하는 대신 실제로 친다. 주입은 React 가 못 보는 경우가 있어,
// '저장이 안 걸린 것' 인지 '검사가 못 친 것' 인지 구분되지 않는다.
await ev(`(()=>{const i=document.querySelector('#pZones .zone-list li .zone-name')
  i.focus(); i.select()})()`)
await sleep(300)
await send('Input.insertText', { text: '창고' })
await sleep(500)
await ev(`document.querySelector('#pZones .zone-list li .zone-name')?.blur()`)
await sleep(2000)
rows = await zoneRows()
console.log('  첫 구역 :', rows?.[0]?.name)
console.log('  → 이름이 바뀐다 :', ok(rows?.[0]?.name === '창고'))
const zoneCalls = be.restCalls.filter((c) => c.url.startsWith('/api/zones'))
console.log('  구역 API 호출 :', zoneCalls.map((c) => `${c.method} ${c.url}`).join(' | ') || '(없음)')
const put = zoneCalls.find((c) => c.method === 'PUT')
console.log('  → 서버에 저장된다 :', ok(!!put), '(화면 입력값만 바뀌면 새로고침에 사라진다)')

await goTab('지도')
// 이름을 바꾼 구역 안으로 로봇을 옮긴다
pose(-1.5, 7.0)
await sleep(1800)
L = await locText()
console.log('  바뀐 뒤 위치 :', JSON.stringify(L?.text))
console.log('  → 화면에 즉시 반영 :', ok(/창고/.test(String(L?.text))), '(캐시가 옛 이름을 붙들면 안 된다)')

console.log('\n[5] 겹치면 작은 구역이 이기는가 (서버와 같은 규칙)')
const rule = await ev(`(async()=>{const m=await import('/src/live/zones.ts')
  const big={id:'b',name:'창고 전체',x1:0,y1:0,x2:10,y2:10}
  const small={id:'s',name:'분전반실',x1:1,y1:1,x2:3,y2:3}
  return {hit:m.zoneAt([big,small],2,2)?.name,
    far:m.locationLabel([big],[{type:'EQUIPMENT',id:'e',name:'분전반 A',x:9,y:9}],1,1),
    near:m.locationLabel([big],[{type:'EQUIPMENT',id:'e',name:'분전반 A',x:1.5,y:1}],1,1)}})()`)
console.log('  ', JSON.stringify(rule))
console.log('  → 작은 구역이 이긴다 :', ok(rule?.hit === '분전반실'), "('창고' 안의 '분전반실' 이 안 잡히면 안 된다)")
console.log('  → 3m 밖은 근처라 하지 않는다 :', ok(!/근처/.test(String(rule?.far))))
console.log('  → 3m 안은 병기한다 :', ok(/분전반 A 근처/.test(String(rule?.near))))

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'Z770-zones.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
