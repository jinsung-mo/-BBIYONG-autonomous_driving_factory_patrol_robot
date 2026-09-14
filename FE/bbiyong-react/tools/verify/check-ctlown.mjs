// 조종 점유(control ownership) 검증 — S15P11E101-778 · 779 / BE MR !344 의 FE 짝.
//
// 요구: "카메라 탭에서 한 사람이 수동 조작 중이면 다른 사용자는 수동 모드로 못 들어간다."
// 실서버는 아직 MR !344 머지 전이라 E2E 가 불가능하다 — 계약을 그대로 구현한 가짜 백엔드
// (fake-backend.mjs 의 ControlOwnershipService 흉내)에 관제 화면 두 개를 붙여 잰다.
//
// 브라우저 두 개(=사용자 두 명의 화면)를 각각 띄운다. 같은 계정으로 로그인하므로 email 은
// 같고 STOMP sessionId 만 다르다 — 이것이 가장 까다로운 조건이다. email 로 소유자를
// 가르는 구현은 여기서 반드시 깨진다.
//
//   [1] A 가 수동 진입 → 점유 획득 · 배너 '내가 조종 중'
//   [2] B 화면: 수동 모드 버튼 비활성 + 'A 님이 조종 중' 배너 + 남은 시간
//   [3] A 가 순찰로 복귀(RELEASE) → B 의 버튼이 풀린다
//   [4] B 가 수동 진입 후, A 가 강제 탈취(TAKEOVER) → B 의 조작이 즉시 잠긴다
//   [5] 관전만 하는 탭은 RELEASE 를 보내지 않는다 (남의 조종을 끊지 않는다)
//   [6] 하트비트를 끊으면 배너가 '확인 중' 으로 내려간다 (낡은 값을 단언하지 않는다)
//   [7] 탭을 닫으면 점유가 즉시 풀린다
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeBackend } from './fake-backend.mjs'

// 프로필은 반드시 저장소 밖에 만든다 — 프로젝트 안에 두면 Chrome 이 쥐고 있는 세션 파일에
// vite 의 파일 감시가 걸려 EBUSY 로 개발 서버가 통째로 죽는다(실측).
const PROFILE_ROOT = mkdtempSync(join(tmpdir(), 'ctlown-'))

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5179/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const FAKE_PORT = Number(process.env.FAKE_PORT || 8099)
const be = await startFakeBackend(FAKE_PORT)

/** 헤드리스 크롬 1개 = 사용자 1명의 화면. user-data-dir 을 갈라 localStorage 를 분리한다. */
async function openBrowser(port, tag) {
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${join(PROFILE_ROOT, tag)}`,
    '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
  let tg
  for (let i = 0; i < 40; i++) {
    try { tg = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (tg.length) break } catch {}
    await sleep(500)
  }
  const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  let id = 0
  const pend = new Map()
  const errs = []
  const net = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    // JS 예외와 네트워크 404 를 섞지 않는다 — 후자는 '활성 도면 없음' 처럼 정상 경로에도 난다
    if (m.method === 'Runtime.exceptionThrown') errs.push('JS: ' + m.params.exceptionDetails?.exception?.description)
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      net.push(`${m.params.entry.url || ''} ${m.params.entry.text}`)
    }
  }
  const send = (me, pa = {}) => new Promise((r) => {
    const i = ++id; pend.set(i, (x) => r(x.result)); ws.send(JSON.stringify({ id: i, method: me, params: pa }))
  })
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(OUT + name, Buffer.from(data, 'base64'))
  }
  return { proc, ws, send, ev, errs, net, shot, tag }
}

/** 로그인 → 카메라 탭까지. 두 화면 모두 같은 계정(test@bbiyong.io · ROLE_ADMIN)을 쓴다. */
async function login(b) {
  await b.send('Page.navigate', { url: APP }); await sleep(1800)
  await b.ev(`localStorage.setItem('bbiyong.dataSource','live')
    localStorage.removeItem('bbiyong.token'); localStorage.removeItem('bbiyong.session')
    localStorage.removeItem('bbiyong.activity'); localStorage.removeItem('bbiyong.lockedAt')`)
  await b.send('Page.reload'); await sleep(2600)
  await b.ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('관제 시스템 접속'))?.click()`)
  await sleep(800)
  await b.ev(`(()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const i=document.querySelectorAll('.auth-card input'); s(i[0],'test@bbiyong.io'); s(i[1],'password'); document.querySelector('.auth-submit').click()})()`)
  await sleep(4500)
  await b.ev(`[...document.querySelectorAll('#nav .navtabs button')].find(x=>x.textContent.trim()==='카메라')?.click()`)
  await sleep(1500)
}

/** 조작 패널이 지금 무엇을 보여주고 무엇을 허용하는지. */
const panel = (b) => b.ev(`(()=>{
  const btns=[...document.querySelectorAll('#pControl .seg button')]
  const manual=btns.find(x=>x.textContent.includes('수동'))
  const own=document.querySelector('#ctlOwn'); const mine=document.querySelector('#ctlOwnMine')
  const denied=document.querySelector('#ctlDenied')
  const pad=[...document.querySelectorAll('#pControl .dpad button')]
  return {
    manualDisabled: !!manual?.disabled,
    manualOn: !!manual?.classList.contains('on'),
    ownBanner: own ? own.textContent.replace(/\\s+/g,' ').trim() : null,
    mineBanner: mine ? mine.textContent.replace(/\\s+/g,' ').trim() : null,
    denied: denied ? denied.textContent.replace(/\\s+/g,' ').trim() : null,
    takeoverBtn: !!document.querySelector('.ctlown-take'),
    padLocked: pad.length>0 && pad.every(x=>x.disabled),
  }})()`)

const clickManual = (b) => b.ev(`(()=>{const x=[...document.querySelectorAll('#pControl .seg button')].find(e=>e.textContent.includes('수동'))
  if(!x||x.disabled) return false; x.click(); return true})()`)
const clickPatrol = (b) => b.ev(`(()=>{const x=[...document.querySelectorAll('#pControl .seg button')].find(e=>e.textContent.includes('순찰'))
  if(!x||x.disabled) return false; x.click(); return true})()`)

const A = await openBrowser(9531, 'A')
const B = await openBrowser(9532, 'B')
await Promise.all([login(A), login(B)])
console.log('두 화면 로그인 완료 · STOMP 세션 :', be.ownershipSessions().map((s) => s.sessionId).join(', '))

console.log('\n[1] A 가 수동 모드로 들어가면 점유를 가져가는가')
console.log('  A 수동 클릭 :', await clickManual(A))
await sleep(1500)
const a1 = await panel(A)
const lease1 = be.ownership()
console.log('  A 패널 :', JSON.stringify(a1))
console.log('  서버 리스 :', lease1 ? `${lease1.email} / ${lease1.sessionId}` : '(없음)')
console.log('  → A 가 소유자가 된다 :', ok(!!lease1))
console.log('  → A 화면에 내가 조종 중 배너 :', ok(!!a1.mineBanner && /내가 조종 중/.test(a1.mineBanner)))
console.log('  → A 는 수동 모드에 머문다 :', ok(a1.manualOn === true && a1.manualDisabled === false))

console.log('\n[2] 그동안 B 는 수동 모드로 못 들어가는가  ← 사용자 요구 본문')
await sleep(900)
const b2 = await panel(B)
console.log('  B 패널 :', JSON.stringify(b2))
console.log('  → B 의 수동 모드 버튼이 잠긴다 :', ok(b2.manualDisabled === true))
console.log('  → 누가 조종 중인지 보인다 :', ok(!!b2.ownBanner && /조종 중/.test(b2.ownBanner)))
console.log('  → 남은 시간이 보인다 :', ok(!!b2.ownBanner && /남은 [\d.]+초/.test(b2.ownBanner)))
console.log('  → 강제 탈취 버튼이 있다 :', ok(b2.takeoverBtn === true))
console.log('  → B 의 조이스틱은 잠겨 있다 :', ok(b2.padLocked === true))
console.log('  B 가 강제로 눌러도 :', await clickManual(B), '(false = 버튼이 실제로 비활성)')
await B.shot('ctlown-B-blocked.png'); await A.shot('ctlown-A-owner.png')

console.log('\n[3] A 가 순찰로 돌아오면 B 가 풀리는가')
await clickPatrol(A); await sleep(1600)
const b3 = await panel(B)
console.log('  서버 리스 :', be.ownership() ? '아직 있음' : '해제됨')
console.log('  B 패널 :', JSON.stringify(b3))
console.log('  → 점유가 해제된다 :', ok(!be.ownership()))
console.log('  → B 의 수동 버튼이 풀린다 :', ok(b3.manualDisabled === false))
console.log('  → 남의 조종 배너가 사라진다 :', ok(b3.ownBanner === null))

console.log('\n[4] B 가 조종 중일 때 A 가 강제 탈취하면')
console.log('  B 수동 클릭 :', await clickManual(B)); await sleep(1600)
const owner4 = be.ownership()
console.log('  서버 리스 소유자 :', owner4?.sessionId)
// 확인 대화상자를 자동 승인시킨다 (window.confirm 은 헤드리스에서 멈춘다)
await A.ev(`window.confirm = () => true`)
const a4click = await A.ev(`(()=>{const b=document.querySelector('.ctlown-take'); if(!b||b.disabled) return false; b.click(); return true})()`)
console.log('  A 강제 탈취 클릭 :', a4click)
await sleep(1800)
const owner4b = be.ownership()
const a4 = await panel(A); const b4 = await panel(B)
console.log('  탈취 후 소유자 :', owner4b?.sessionId, '(이전:', owner4?.sessionId, ')')
console.log('  A 패널 :', JSON.stringify(a4))
console.log('  B 패널 :', JSON.stringify(b4))
console.log('  → 소유자가 A 로 바뀐다 :', ok(!!owner4b && owner4b.sessionId !== owner4?.sessionId))
console.log('  → 정지 프레임이 발행된다 :', ok(be.sends.some((s) => /점유 전환 정지 프레임/.test(s.reason || ''))))
console.log('  → B 의 조작이 즉시 잠긴다 :', ok(b4.manualOn === false && b4.padLocked === true))
console.log('  → B 에 빼앗긴 사유가 뜬다 :', ok(!!b4.denied && /가져갔|조종 중/.test(b4.denied)))
console.log('  → A 가 조종자가 된다 :', ok(a4.manualOn === true))
await B.shot('ctlown-B-takenover.png')

console.log('\n[5] 관전만 하는 탭이 남의 조종을 끊지 않는가')
// B 는 지금 수동 모드가 아니다(관전 상태). B 를 blur/visibilitychange 로 흔들어도
// RELEASE 가 나가면 안 된다 — 오늘 로컬 대시보드에서 실측된 사고와 같은 형태다.
const beforeRelease = be.sends.filter((s) => /"command":"RELEASE"/.test(s.body || '')).length
await B.ev(`window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange'))
  Object.defineProperty(document,'hidden',{value:true,configurable:true})
  document.dispatchEvent(new Event('visibilitychange'))`)
await sleep(1500)
const afterRelease = be.sends.filter((s) => /"command":"RELEASE"/.test(s.body || '')).length
const stillOwned = be.ownership()
console.log('  RELEASE 발행 누적 :', beforeRelease, '→', afterRelease)
console.log('  → 관전 탭은 RELEASE 를 보내지 않는다 :', ok(afterRelease === beforeRelease))
console.log('  → A 의 조종이 유지된다 :', ok(!!stillOwned), stillOwned ? stillOwned.sessionId : '')

console.log('\n[6] 갱신이 끊기면 낡은 값을 사실로 단언하지 않는가')
// 소켓은 살아 있는데 점유 방송만 멎은 상황. 마지막으로 본 남은시간을 계속 카운트다운하며
// "아직 A 가 조종 중" 이라고 단언하면, 그것은 근거 없는 화면이다.
const removed = be.subs.filter((s) => s.destination.startsWith('/topic/control/'))
removed.forEach((s) => be.subs.splice(be.subs.indexOf(s), 1))
await sleep(4500)
const b6 = await panel(B); const a6 = await panel(A)
console.log('  A 패널 :', JSON.stringify(a6))
console.log('  B 패널 :', JSON.stringify(b6))
console.log('  → A(소유자) 배너가 확인 중으로 내려간다 :', ok(/확인 중/.test(a6.mineBanner || '')))
console.log('  → A 의 조이스틱도 잠긴다 :', ok(a6.padLocked === true),
  '(리스 2초 < 무수신 3초 — 서버는 이미 만료시켰을 공산이 크다)')
console.log('  → B(관전) 배너도 확인 중으로 내려간다 :', ok(/확인 중/.test(b6.ownBanner || '')))
console.log('  → 그동안에도 진입은 계속 막는다 :', ok(b6.manualDisabled === true),
  '(모른다고 열어 주면 두 사람이 동시에 잡는다)')
removed.forEach((s) => be.subs.push(s))
await sleep(1500)
const b6b = await panel(B)
console.log('  → 방송이 돌아오면 확인 중이 걷힌다 :', ok(!/확인 중/.test(b6b.ownBanner || '')))

console.log('\n[7] 탭을 닫으면 점유가 즉시 풀리는가')
A.ws.close(); A.proc.kill()
await sleep(1500)
console.log('  → 세션 종료로 해제된다 :', ok(!be.ownership()))

console.log('\nJS 예외 A :', A.errs.length ? A.errs.slice(0, 3) : '없음')
console.log('JS 예외 B :', B.errs.length ? B.errs.slice(0, 3) : '없음')
// 네트워크 404 는 따로 적는다 — '활성 도면 없음' 처럼 정상 경로에서도 나므로 0 이 목표가 아니다
console.log('네트워크 오류 :', [...new Set([...A.net, ...B.net].map((x) => x.split(' - ')[0]))].slice(0, 6))
B.ws.close(); B.proc.kill()
await be.close()
process.exit(0)
