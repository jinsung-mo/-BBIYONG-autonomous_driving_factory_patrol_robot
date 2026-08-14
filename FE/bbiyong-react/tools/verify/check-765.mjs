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
  '--remote-debugging-port=9513', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9513/json/list')).json(); if (tg.length) break } catch {}
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
const closeModal = () => ev(`(()=>{const b=[...document.querySelectorAll('.modal button, .evd button')]
  .find(x=>/닫기|취소|×|✕/.test(x.textContent||'')); if(b){b.click(); return true}
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return false})()`)
// 모달 자체를 찾는다. 상세가 없을 때도(404·오류) 창은 떠서 사정을 말해야 한다 —
// 클릭했는데 아무 일도 안 일어나는 것이 이 티켓의 증상이었다.
const modal = () => ev(`(()=>{const t=[...document.querySelectorAll('h3,h2,.modal-title,[class*=title]')]
    .find(e=>/이벤트 상세/.test(e.textContent||''))
  const root=t?(t.closest('.modal')||t.parentElement.parentElement):null
  if(!root) return null
  return {open:true, text:(root?.textContent||'').replace(/\\s+/g,' ').slice(0,120),
    video:!!root?.querySelector('video, source, .evd-clip, .clipbtn, [class*=clip]'),
    // 영상이 없을 때 그 사실을 말하는지. 침묵하면 조작자는 로딩 중인지 없는지 모른다.
    empty:/영상|클립/.test(root?.textContent||'')}})()`)

console.log('\n[1] 이벤트 탭에서 행을 클릭하면 상세가 열리는가')
await goTab('이벤트')
const rows = await ev(`document.querySelectorAll('#pgEvents .elog li, #pgEvents .logrow').length`)
const clickable = await ev(`document.querySelectorAll('#pgEvents .logopen').length`)
console.log('  행', rows, '개 · 클릭 가능', clickable, '개')
console.log('  → 클릭 가능한 행이 있다 :', ok(clickable > 0), '(eventId 가 없으면 비클릭 텍스트가 된다)')
await ev(`document.querySelector('#pgEvents .logopen')?.click()`); await sleep(1800)
let m = await modal()
console.log('  모달 :', m ? m.text.slice(0, 60) : '(안 열림)')
console.log('  → 상세 모달이 뜬다 :', ok(!!m?.open))
console.log('  → 영상 자리가 있다 :', ok(!!m && (m.video || m.empty)), '(영상이 없으면 없다고 말해야 한다)')
const videoCalls = be.restCalls.filter((c) => /\/api\/events\/\d+\/video|\/api\/videos\//.test(c.url)).length
console.log('  영상 API 호출 :', videoCalls, '회')
console.log('  → 전후 영상을 조회한다 :', ok(videoCalls >= 1))
{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'E765-detail.png', Buffer.from(data, 'base64'))
}
await closeModal(); await sleep(700)

console.log('\n[2] 실시간으로 막 받은 경보도 클릭 가능한가')
// 서버가 eventId 를 실어 보내는 경우 — 저장이 끝난 이벤트다
be.push('/topic/alerts', {
  type: 'FIRE', eventId: 4242, level: 'CRITICAL', robotId: 'orinka_01',
  message: '화재 발생 · 실시간', timestamp: new Date().toISOString(),
})
await sleep(1500)
const live = await ev(`(()=>{const rows=[...document.querySelectorAll('#pgEvents .elog li, #pgEvents .logrow')]
  const hit=rows.find(r=>/실시간/.test(r.textContent||''))
  if(!hit) return null
  return {found:true, clickable:!!hit.querySelector('.logopen'),
    tag:!!hit.querySelector('.tag.live')}})()`)
console.log('  실시간 행 :', JSON.stringify(live))
console.log('  → 행이 보인다 :', ok(!!live?.found))
console.log('  → 클릭 가능하다 :', ok(live?.clickable === true), '(eventId 가 유지돼야 한다)')

console.log('\n[3] 지도 사이드 로그에서도 열리는가')
await goTab('지도')
await sleep(900)
const sideClickable = await ev(`document.querySelectorAll('#pgMap .logopen').length`)
console.log('  지도 사이드 클릭 가능 행 :', sideClickable, '개')
console.log('  → 사이드 로그에서도 열린다 :', ok(sideClickable > 0),
  '(보던 자리에서 열려야 화면에서 눈을 떼지 않는다)')
const clicked = await ev(`(()=>{const b=document.querySelector('#pgMap .logopen'); if(!b) return null
  b.click(); return b.textContent.trim().slice(0,30)})()`)
await sleep(2600)
const sideModal = await modal()
console.log('  누른 행 :', clicked)
console.log('  → 상세 모달이 뜬다 :', ok(!!sideModal?.open), sideModal ? sideModal.text.slice(0, 50) : '')
console.log('  → 상세든 사정이든 말한다 :', ok(!!sideModal && sideModal.text.length > 5),
  '(눌렀는데 아무 일도 없으면 고장으로 읽힌다)')
await closeModal(); await sleep(600)

console.log('\n[4] eventId 가 없는 경보는 어떻게 되는가')
// 로봇이 저장 전에 먼저 쏘는 경우가 있다. 그때는 열 상세가 없으므로 비클릭이 맞다.
await goTab('이벤트')
be.push('/topic/alerts', {
  type: 'OVERHEAT', level: 'WARNING', robotId: 'orinka_01',
  message: '과열 감지 · id 없음', timestamp: new Date().toISOString(),
})
await sleep(1500)
const noId = await ev(`(()=>{const rows=[...document.querySelectorAll('#pgEvents .elog li, #pgEvents .logrow')]
  const hit=rows.find(r=>/id 없음/.test(r.textContent||''))
  return hit ? {found:true, clickable:!!hit.querySelector('.logopen')} : null})()`)
console.log('  id 없는 행 :', JSON.stringify(noId))
console.log('  → 표시는 된다 :', ok(!!noId?.found), '(경보 자체를 숨기면 안 된다)')
console.log('  → 클릭은 막힌다 :', ok(noId?.clickable === false), '(열 상세가 없는데 눌리면 빈 모달이 뜬다)')

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
