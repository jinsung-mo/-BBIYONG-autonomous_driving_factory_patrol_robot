// 관제센터 신규 API 화면 검증 — 요약 띠 · 이벤트 필터 · 스케줄 · 통계 · 건강 이력 · 알림 설정
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
  '--remote-debugging-port=9301', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9301/json/list')).json(); if (tg.length) break } catch {}
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
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(OUT + n, Buffer.from(data, 'base64'))
}
const click = (text, scope = 'body') =>
  ev(`[...document.querySelectorAll(${JSON.stringify(scope)} + ' button, ' + ${JSON.stringify(scope)} + ' *')].filter(e=>e.tagName==='BUTTON'&&e.textContent.trim()===${JSON.stringify(text)})[0]?.click()`)

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP }); await sleep(1600)
await ev(`localStorage.setItem('bbiyong.dataSource','live')`)
await send('Page.reload'); await sleep(2600)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('관제 시스템 접속'))?.click()`); await sleep(700)
await ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password');
  document.querySelector('.auth-submit').click()})()`)
await sleep(3500)

console.log('\n[1] 관제 요약 띠 — GET /api/dashboard/stats')
const cards = await ev(`[...document.querySelectorAll('#pSummary .sumcard')].map(c=>c.querySelector('span').textContent+'='+c.querySelector('b').textContent.replace(/\\s+/g,''))`)
console.log('  카드      :', (cards || []).join(' · '))
// S15P11E101-630 에서 설비 집계 카드가 붙었다. 로봇·이벤트 7칸이 그대로 있는지로 본다.
const ROBOT_EVENT = ['가동 중 로봇', '온라인', '충전 중', '평균 배터리', '오늘 이벤트', '오늘 긴급', '미해결']
console.log('  로봇·이벤트 7칸 :', ok(ROBOT_EVENT.every((k) => (cards || []).some((c) => c.startsWith(k + '=')))))
console.log('  호출됨    :', ok(be.restCalls.some((c) => c.url.startsWith('/api/dashboard/stats'))))

console.log('\n[2] 이벤트 로그 필터 — level / status / 기간이 쿼리로 나가는가')
const before = be.restCalls.length
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[0];
  const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  d.call(s,'CRITICAL'); s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(900)
const q1 = be.restCalls.slice(before).map((c) => c.url).filter((u) => u.startsWith('/api/events?'))
console.log('  심각도    :', ok(q1.some((u) => u.includes('level=CRITICAL'))), q1[0] || '(호출 없음)')

const b2 = be.restCalls.length
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[1];
  const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  d.call(s,'UNRESOLVED'); s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(900)
const q2 = be.restCalls.slice(b2).map((c) => c.url).filter((u) => u.startsWith('/api/events?'))
console.log('  상태      :', ok(q2.some((u) => u.includes('status=UNRESOLVED'))), q2[0] || '(호출 없음)')

const b3 = be.restCalls.length
await ev(`(()=>{const s=document.querySelectorAll('#pStatus .logfilter2 select')[2];
  const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  d.call(s,'D7'); s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(900)
const q3 = be.restCalls.slice(b3).map((c) => c.url).filter((u) => u.startsWith('/api/events?'))
console.log('  기간      :', ok(q3.some((u) => /startDate=\d{4}-\d{2}-\d{2}/.test(u))), q3[0] || '(호출 없음)')
console.log('  긴급 태그 :', await ev(`document.querySelectorAll('#pStatus .elog .tag.crit').length`), '개')
await shot('CC-1-live.png')

console.log('\n[3] 운영 탭 — 스케줄 · 건강 이력 · 이벤트 통계')
await ev(`[...document.querySelectorAll('nav button, .nav button, header button')].find(b=>b.textContent.trim()==='운영')?.click()`)
await sleep(2500)
const schRows = await ev(`[...document.querySelectorAll('#schList li')].map(l=>l.querySelector('b')?.textContent+' | '+l.querySelector('.sch-when')?.textContent)`)
console.log('  스케줄    :', (schRows || []).join(' / '))
console.log('  cron 해석 :', ok((schRows || []).some((r) => r && r.includes('매일 20:00'))))
console.log('  건강 차트 :', ok(await ev(`!!document.querySelector('#pHealth .chart svg')`)),
  '· 선', await ev(`document.querySelectorAll('#pHealth .chart-line').length`), '개')
const dGap = await ev(`(()=>{const p=document.querySelector('#pHealth .chart-line'); return (p?.getAttribute('d')||'').split('M').length-1})()`)
console.log('  선 끊김   :', ok(dGap >= 2), `(M 세그먼트 ${dGap}개 — 오프라인 구간에서 끊겨야 한다)`)
console.log('  오프라인  :', await ev(`document.querySelector('#pHealth .cfg-note .warn')?.textContent?.trim() || '(없음)'`))
console.log('  통계 차트 :', ok(await ev(`!!document.querySelector('#pEventStats .chart svg')`)))
console.log('  통계 합계 :', await ev(`document.querySelector('#pEventStats .cfg-note')?.textContent?.replace(/\\s+/g,' ').trim()`))
await shot('CC-2-ops.png')

console.log('\n[4] 통계 묶음 기준 전환 — 시계열↔막대')
const b4 = be.restCalls.length
await ev(`[...document.querySelectorAll('#pEventStats .logfilter button')].find(b=>b.textContent.trim()==='로봇별')?.click()`)
await sleep(1200)
console.log('  by-robot  :', ok(be.restCalls.slice(b4).some((c) => c.url.includes('/api/events/stats/by-robot'))))
console.log('  막대 렌더 :', ok((await ev(`document.querySelectorAll('#pEventStats .chart svg rect').length`)) > 0),
  '· 꺾은선 없음', ok((await ev(`document.querySelectorAll('#pEventStats .chart-line').length`)) === 0))

console.log('\n[5] 스케줄 추가 / 중지 / 삭제')
const schBefore = await ev(`document.querySelectorAll('#schList li').length`)
const b5 = be.restCalls.length
await ev(`(()=>{const el=document.querySelector('#sch-name');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,'검증용 순찰');
  el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(300)
await ev(`[...document.querySelectorAll('#pSchedule button')].find(b=>b.textContent.includes('스케줄 추가'))?.click()`)
// 고정 대기로는 간헐 실패한다 — 요청이 실제로 나올 때까지 기다린다
const waitPost = async () => {
  for (let i = 0; i < 30; i++) {
    const p = be.restCalls.slice(b5).find((c) => c.method === 'POST' && c.url === '/api/patrol-schedules')
    if (p) { await sleep(600); return p }
    await sleep(200)
  }
  return null
}
const post = await waitPost()
console.log('  POST 본문 :', JSON.stringify(post?.body))
console.log('  추가됨    :', ok(!!post && post.body?.name === '검증용 순찰' && post.body?.cronExpression === '0 0 20 * * *'))
console.log('  목록 반영 :', ok((await ev(`document.querySelectorAll('#schList li').length`)) === schBefore + 1))
console.log('  안내 문구 :', await ev(`document.querySelector('#schMsg')?.textContent`))

const b6 = be.restCalls.length
await ev(`(()=>{const li=[...document.querySelectorAll('#schList li')].find(l=>l.textContent.includes('검증용 순찰'));
  [...li.querySelectorAll('button')].find(b=>b.textContent.trim()==='중지')?.click()})()`)
await sleep(1300)
const put = be.restCalls.slice(b6).find((c) => c.method === 'PUT')
console.log('  중지 PUT  :', ok(!!put && put.body?.enabled === false), put?.url || '')

const b7 = be.restCalls.length
await ev(`(()=>{const li=[...document.querySelectorAll('#schList li')].find(l=>l.textContent.includes('검증용 순찰'));
  [...li.querySelectorAll('button')].find(b=>b.textContent.trim()==='삭제')?.click()})()`)
await sleep(600)
console.log('  확인 모달 :', ok(await ev(`!!document.querySelector('.modal, [role=dialog]')`)))
await ev(`[...document.querySelectorAll('.modal button, [role=dialog] button')].find(b=>b.textContent.trim()==='삭제')?.click()`)
await sleep(1300)
console.log('  DELETE    :', ok(be.restCalls.slice(b7).some((c) => c.method === 'DELETE' && /patrol-schedules\/\d+/.test(c.url))))
console.log('  목록 복귀 :', ok((await ev(`document.querySelectorAll('#schList li').length`)) === schBefore))

console.log('\n[6] 잘못된 cron 은 보내기 전에 막는가')
await ev(`(()=>{const c=[...document.querySelectorAll('#pSchedule input[type=checkbox]')][0]; c.click()})()`)
await sleep(300)
await ev(`(()=>{const el=document.querySelector('#sch-cron');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,'0 20 * * *');
  el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(400)
console.log('  경고 문구 :', await ev(`document.querySelector('#pSchedule .form-msg.err')?.textContent || '(없음)'`))
console.log('  버튼 잠김 :', ok(await ev(`[...document.querySelectorAll('#pSchedule button')].find(b=>b.textContent.includes('스케줄 추가'))?.disabled`)))

console.log('\n[7] 설정 탭 — Mattermost 알림')
await ev(`[...document.querySelectorAll('nav button, .nav button, header button')].find(b=>b.textContent.trim()==='설정')?.click()`)
await sleep(1800)
console.log('  패널 노출 :', ok(await ev(`!!document.querySelector('#pNotify')`)))
console.log('  초기 상태 :', await ev(`document.querySelector('#pNotify input[type=checkbox]')?.checked`))
await ev(`document.querySelector('#pNotify input[type=checkbox]').click()`)
await sleep(300)
console.log('  URL 없음  :', await ev(`document.querySelector('#pNotify .form-msg.err')?.textContent || '(없음)'`))
console.log('  저장 잠김 :', ok(await ev(`[...document.querySelectorAll('#pNotify button')].find(b=>b.textContent.includes('저장'))?.disabled`)))
await ev(`(()=>{const set=(id,v)=>{const el=document.querySelector(id);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);
  el.dispatchEvent(new Event('input',{bubbles:true}))};
  set('#ntf-url','https://meeting.ssafy.com/hooks/abc')})()`)
await sleep(300)
await ev(`(()=>{const s=document.querySelector('#ntf-sev');
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'CRITICAL');
  s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
await sleep(300)
const b8 = be.restCalls.length
await ev(`[...document.querySelectorAll('#pNotify button')].find(b=>b.textContent.includes('저장'))?.click()`)
await sleep(1300)
const nput = be.restCalls.slice(b8).find((c) => c.url.startsWith('/api/notifications/settings') && c.method === 'PUT')
console.log('  PUT 본문  :', JSON.stringify(nput?.body))
// S15P11E101-634 에서 채널 입력을 없애고 항상 빈 값으로 보낸다 — 웹훅 기본 채널을 쓴다.
console.log('  채널 :', ok(nput?.body?.mattermostChannel === ''), '(634 이후 입력을 두지 않는다)')
console.log('  저장 안내 :', await ev(`document.querySelector('#ntfMsg')?.textContent`))
await shot('CC-3-config.png')

console.log('\n[8] 시뮬레이션 모드에서는 신규 패널이 나오지 않는가')
await ev(`localStorage.setItem('bbiyong.dataSource','mock')`)
await send('Page.reload'); await sleep(3000)
console.log('  요약 띠   :', ok(!(await ev(`!!document.querySelector('#pSummary')`))), '(없어야 함)')

console.log('\n콘솔 에러:', errs.length ? errs.slice(0, 4) : '없음')
ws.close(); chrome.kill(); await be.close(); process.exit(0)
