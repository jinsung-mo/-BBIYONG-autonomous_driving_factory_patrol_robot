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
  '--remote-debugging-port=9521', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9521/json/list')).json(); if (tg.length) break } catch {}
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
// S15P11E101-768 검증 — 통계 지표 3종
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 통계 탭에서 3개 지표가 실데이터로 렌더링된다
//   2. 데이터 없음·추정 불가 상태가 오류 없이 표기된다
const panel = () => ev(`(()=>{const p=document.querySelector('#pMetrics'); if(!p) return null
  const txt=(el)=>(el?.textContent||'').replace(/\s+/g,' ').trim()
  const ranks=[...p.querySelectorAll('.rankbars li')].map(li=>({
    name:txt(li.querySelector('b')),
    count:txt(li.querySelector('.rankbar-top .mono')),
    when:txt(li.querySelector('.rankbar-when')),
    width:li.querySelector('.rankbar i')?.style.width}))
  const days=[...p.querySelectorAll('.weekbars li')].map(li=>({
    day:txt(li.querySelector('.weekbar-day')),
    fire:li.querySelector('.weekbar i.fire')?.style.height,
    heat:li.querySelector('.weekbar i.heat')?.style.height}))
  const kvs=[...p.querySelectorAll('.kv')].map(k=>txt(k))
  const battSec=[...p.querySelectorAll('.metric')].find(sec=>sec.querySelector('.metric-big'))
  return {ranks, days, big:txt(p.querySelector('.metric-big')), kvs,
    note:txt(battSec?.querySelector('p.cfg-help')),
    err:txt(p.querySelector('.form-msg.err'))}})()`)

await goTab('통계')
await sleep(1200)
let p = await panel()

console.log('\n[1] 세 지표가 실데이터로 그려지는가')
console.log('  패널 :', ok(!!p), p?.err ? `오류: ${p.err}` : '')
console.log('  과열 랭킹 :', JSON.stringify(p?.ranks))
console.log('  → 설비명·건수·마지막 시각이 함께 있다 :',
  ok((p?.ranks?.length ?? 0) >= 2 && p.ranks.every((r) => r.name && /건/.test(r.count) && /마지막/.test(r.when))))
console.log('  → 많이 난 순으로 온다 :',
  ok(p?.ranks?.[0]?.name === '분전반 A'), '(어느 설비를 먼저 점검할지가 첫 줄이어야 한다)')
console.log('  → 미등록 설비는 ID 폴백 :', ok(p?.ranks?.[1]?.name === 'panel_B'))

console.log('  주간 추이 :', (p?.days || []).map((d) => d.day).join(' '))
console.log('  → 7일이 모두 자리를 지킨다 :', ok(p?.days?.length === 7), '(0 인 날이 빠지면 추이가 아니라 목록이다)')
const zero = (p?.days || []).find((d) => d.day === '07/31')
console.log('  0건인 날 막대 :', JSON.stringify(zero))
console.log('  → 0 인 날은 막대가 없다 :', ok(zero?.fire === '0%' && zero?.heat === '0%'))
console.log('  → 화재·과열을 갈라 그린다 :', ok((p?.days || []).some((d) => d.fire !== '0%' && d.heat !== '0%')))

console.log('  배터리 :', p?.big, '·', JSON.stringify(p?.kvs))
console.log('  → 현재 값 :', ok(/68/.test(String(p?.big))))
console.log('  → 소모 추세 :', ok((p?.kvs || []).some((k) => /12 %\/h/.test(k))))
console.log('  → 예상 잔여 :', ok((p?.kvs || []).some((k) => /약 5시간 40분/.test(k))), '(340분)')
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'S768-metrics.png', Buffer.from(data, 'base64'))
}

console.log('\n[2] 추정 불가 상태가 오류 없이 표기되는가')
// 충전 중 — BE 는 소모율만 주고 잔여시간은 null 로 내린다
be.setStatsBattery({ robotId: 'orinka_01', battery: 91.0, dischargePerHour: -3.0, estimatedRemainingMinutes: null })
await ev(`[...document.querySelectorAll('#pMetrics button')].find(b=>/새로고침/.test(b.textContent))?.click()`)
await sleep(1600)
p = await panel()
console.log('  충전 중 :', p?.big, '·', JSON.stringify(p?.kvs), '·', p?.note)
console.log('  → 잔여시간은 — :', ok((p?.kvs || []).some((k) => /예상 잔여 가동\s*—/.test(k))))
console.log('  → 왜 모르는지 말한다 :', ok(/충전/.test(String(p?.note))), '(모른다 보다 왜 모르는지가 쓸모 있다)')
console.log('  → 오류로 뜨지 않는다 :', ok(!p?.err))

// 자료 부족 — 둘 다 null
be.setStatsBattery({ robotId: 'orinka_01', battery: null, dischargePerHour: null, estimatedRemainingMinutes: null })
be.setStatsOverheat({ periodDays: 7, totalCount: 0, items: [] })
be.setStatsWeekly({ periodDays: 7, items: [] })
await ev(`[...document.querySelectorAll('#pMetrics button')].find(b=>/새로고침/.test(b.textContent))?.click()`)
await sleep(1600)
p = await panel()
console.log('  자료 없음 :', p?.big, '·', p?.note)
console.log('  → 값 없음은 — :', ok(p?.big === '—'))
console.log('  → 자료 부족을 말한다 :', ok(/자료/.test(String(p?.note))))
console.log('  → 빈 목록도 오류가 아니다 :', ok(!p?.err && (p?.ranks?.length ?? 0) === 0))

console.log('\n[3] 조회는 전용 API 를 쓰는가')
const calls = be.restCalls.map((c) => c.url)
for (const path of ['/api/stats/overheat-equipment', '/api/stats/alerts-weekly', '/api/stats/battery-estimate']) {
  console.log(`  → ${path} :`, ok(calls.some((u) => u.startsWith(path))))
}
console.log('  → by-equipment 로 대신하지 않는다 :', ok(!calls.some((u) => u.includes('stats/by-equipment'))),
  '(전용 API 가 유형까지 갈라 준다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
