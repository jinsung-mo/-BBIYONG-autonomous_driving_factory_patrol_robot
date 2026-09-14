// S15P11E101-630 검증 — 대시보드 설비 집계 표시
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
  '--remote-debugging-port=9431', '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9431/json/list')).json(); if (tg.length) break } catch {}
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
const cards = () => ev(`[...document.querySelectorAll('#pSummary .sumcard')].map(c=>c.querySelector('span').textContent+'='+c.querySelector('b').textContent.replace(/\\s+/g,''))`)
const login = async () => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
  await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password');
    document.querySelector('.auth-submit').click()})()`)
  await sleep(3600)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)
await login()

console.log('\n[1] 설비 집계가 요약 띠에 나오는가')
const c1 = await cards()
console.log('  카드 :', (c1 || []).join(' · '))
console.log('  → 설비 정상 :', ok((c1 || []).some((c) => c.startsWith('설비 정상=1/3'))))
console.log('  → 설비 과열 :', ok((c1 || []).some((c) => c.startsWith('설비 과열=1'))))
console.log('  → 설비 미점검 :', ok((c1 || []).some((c) => c.startsWith('설비 미점검=1'))))
console.log('  → 로봇·이벤트 카드도 그대로 :', ok((c1 || []).some((c) => c.startsWith('가동 중 로봇'))
  && (c1 || []).some((c) => c.startsWith('오늘 이벤트'))))

console.log('\n[2] 과열 설비가 어디인지 알려주는가')
const hot = await ev(`document.querySelector('#pSummaryHot')?.textContent?.trim()`)
console.log('  문구 :', hot)
console.log('  → 설비 이름 노출 :', ok(!!hot && hot.includes('B구역 분전반')), '(숫자만으로는 현장에 갈 수 없다)')
console.log('  → 과열 카드 강조 :', ok(await ev(`[...document.querySelectorAll('#pSummary .sumcard.hot')].some(c=>c.textContent.includes('설비 과열'))`)))
const { data: s1 } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT + 'E630-summary.png', Buffer.from(s1, 'base64'))

console.log('\n[3] 같은 목록을 두 번 긁지 않는가')
const eqCalls = be.restCalls.filter((c) => (c.url || '').startsWith('/api/equipments'))
console.log('  /api/equipments 호출 :', eqCalls.length, '회')
console.log('  → 대시보드가 주면 생략 :', ok(eqCalls.length === 0), '(equipmentStatus 를 그대로 쓴다)')

console.log('\n[4] 과열이 해소되면 줄이 사라지는가')
be.equipments.forEach((e) => { if (e.status === 'OVER') e.status = 'NORMAL' })
await ev(`(()=>{const b=[...document.querySelectorAll('.navtabs button')]; b[0].click()})()`)
await sleep(31000)   // 요약 띠는 30초 주기로 갱신한다
const c2 = await cards()
console.log('  카드 :', (c2 || []).filter((c) => c.startsWith('설비')).join(' · '))
console.log('  → 과열 0 :', ok((c2 || []).some((c) => c.startsWith('설비 과열=0'))))
console.log('  → 과열 줄 사라짐 :', ok(!(await ev(`!!document.querySelector('#pSummaryHot')`))))
console.log('  → 강조도 풀림 :', ok(!(await ev(`[...document.querySelectorAll('#pSummary .sumcard.hot')].some(c=>c.textContent.includes('설비 과열'))`))))

console.log('\n[5] 설비 집계를 주지 않는 서버에서도 화면이 온전한가')
be.setWithEquipment(false)
await send('Page.reload'); await sleep(3200)
const c3 = await cards()
console.log('  카드 :', (c3 || []).join(' · '))
console.log('  → 설비 카드 없음 :', ok(!(c3 || []).some((c) => c.startsWith('설비'))))
console.log('  → 로봇·이벤트는 그대로 :', ok((c3 || []).length === 7))
console.log('  → 목록은 /api/equipments 로 대체 조회 :', ok(be.restCalls.some((c) => (c.url || '').startsWith('/api/equipments'))))
be.setWithEquipment(true)

console.log('\n[6] 시뮬레이션 모드에는 요약 띠가 없다')
await ev(`localStorage.setItem('bbiyong.dataSource','mock')`)
await send('Page.reload'); await sleep(2800)
console.log('  → 요약 띠 없음 :', ok(!(await ev(`!!document.querySelector('#pSummary')`))))

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
