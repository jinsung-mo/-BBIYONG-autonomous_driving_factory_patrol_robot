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
  '--remote-debugging-port=9517', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9517/json/list')).json(); if (tg.length) break } catch {}
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
  await sleep(1300)
}
// S15P11E101-766 검증 — 로봇 표시명 통일
//
// 완료 기준 두 가지를 그대로 잰다.
//   1. 화면 어디에도 orinka_01 이 노출되지 않고 BBIYONGBOT_01 로 표시된다
//   2. 로봇 통신·구독·제어는 계약 id 로 그대로 동작한다
//
// '화면에 없다' 는 DOM 텍스트로 잰다. 클래스나 데이터 속성이 아니라 사람이 읽는 글자만
// 본다 — 그래야 '보이는 것' 과 '주고받는 것' 을 갈라 볼 수 있다.
const visibleText = () => ev(`(()=>{
  const walk=(el)=>{
    const s=getComputedStyle(el)
    if(s.display==='none'||s.visibility==='hidden'||el.hasAttribute('hidden')) return ''
    let out=''
    for(const n of el.childNodes){
      if(n.nodeType===3) out += n.nodeValue
      else if(n.nodeType===1) out += walk(n)
    }
    return out
  }
  return walk(document.body).replace(/\s+/g,' ')})()`)

const TABS = ['지도', '카메라', '이벤트', '통계', '운영', '설정']
console.log('\n[1] 화면에 계약 id 가 노출되지 않는가')
let anyAlias = false
for (const tab of TABS) {
  await goTab(tab)
  const txt = await visibleText()
  const raw = (txt.match(/orinka_01/g) || []).length
  const alias = (txt.match(/BBIYONGBOT_01/g) || []).length
  if (alias > 0) anyAlias = true
  console.log(`  ${tab.padEnd(3)} · orinka_01 ${raw}회 · BBIYONGBOT_01 ${alias}회`, ok(raw === 0))
}
console.log('  → 표시명이 실제로 쓰인다 :', ok(anyAlias), '(어디에도 안 뜨면 바꾼 보람이 없다)')

console.log('\n[2] 서버 문구 안에 박힌 id 도 바뀌는가')
await goTab('이벤트')
be.push('/topic/alerts', {
  type: 'FIRE', eventId: 7001, level: 'CRITICAL', robotId: 'orinka_01',
  message: '화재 발생 · orinka_01 구역 A', timestamp: new Date().toISOString(),
})
await sleep(1600)
const row = await ev(`(()=>{const rows=[...document.querySelectorAll('#pgEvents .elog li, #pgEvents .logrow')]
  const hit=rows.find(r=>/구역 A/.test(r.textContent||''))
  return hit ? hit.textContent.replace(/\s+/g,' ').trim() : null})()`)
console.log('  행 :', row)
console.log('  → 문장 속 id 도 바뀐다 :', ok(!!row && !/orinka_01/.test(row) && /BBIYONGBOT_01/.test(row)),
  '(BE 가 조립한 문구라 뒤에 붙는 id 만 바꾸면 남는다)')

console.log('\n[3] 통신 계약은 그대로인가')
const subs = be.subs.map((s) => s.destination)
console.log('  구독 :', subs.filter((d) => /orinka/.test(d)).join(' · ') || '(없음)')
console.log('  → 토픽은 계약 id 를 쓴다 :', ok(subs.some((d) => d.includes('orinka_01'))),
  '(표시명으로 바꾸면 로봇을 못 찾는다)')
console.log('  → 표시명으로 구독하지 않는다 :', ok(!subs.some((d) => /BBIYONGBOT/i.test(d))))
const rest = be.restCalls.map((c) => c.url)
console.log('  → REST 도 계약 id :', ok(!rest.some((u) => /BBIYONGBOT/i.test(u))),
  `(표시명이 섞인 요청 ${rest.filter((u) => /BBIYONGBOT/i.test(u)).length}건)`)

console.log('\n[4] 모르는 로봇은 원문을 지킨다')
const fallback = await ev(`(async()=>{const m=await import('/src/live/robotName.ts')
  return {known:m.displayName('orinka_01'), unknown:m.displayName('robot_zz'),
    empty:m.displayName(null), inText:m.withDisplayNames('a orinka_01 b')}})()`)
console.log('  ', JSON.stringify(fallback))
console.log('  → 등록된 id 는 표시명 :', ok(fallback?.known === 'BBIYONGBOT_01'))
console.log('  → 모르는 id 는 원문 :', ok(fallback?.unknown === 'robot_zz'), '(이름을 지어내면 어느 로봇인지 잃는다)')

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'N766-alias.png', Buffer.from(data, 'base64'))
}
console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
