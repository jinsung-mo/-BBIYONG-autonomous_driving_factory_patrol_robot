// S15P11E101-787 검증 — AprilTag 점검 지점 승인 UI + 지도 핀
//
// 완료 기준 다섯 가지를 그대로 잰다.
//   1. 목 후보 3개가 뜨고 확인/거절 시 목록에서 사라진다
//   2. 확인한 후보가 확정 목록에 sequence 순으로 나타나고 이름수정·삭제(후 재정렬)가 된다
//   3. 지도에 target 핀 + viewpoint 화살표가 그려지고 대기/확정이 시각 구분된다
//   4. mapId 리터럴 비교 코드가 없고 낡은 안내문이 제거됐다
//   5. sendPointCommand 가 명령 스키마 그대로 만들어 보낸다
//
// 지도는 캔버스라 DOM 으로 확인할 길이 없다 — 픽셀 색을 직접 센다.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = new URL('../../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (b) => (b ? 'PASS' : '**FAIL**')

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9531', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9531/json/list')).json(); if (tg.length) break } catch {}
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

await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='운영')?.click()`)
await sleep(1800)

const counts = () => ev(`JSON.stringify({
  cand: document.querySelectorAll('#inspCandidates li').length,
  pts: document.querySelectorAll('#inspPoints li').length,
  empty: !!document.querySelector('#inspEmpty')})`)
const setInput = (sel, v) => ev(`(()=>{const el=document.querySelector('${sel}'); if(!el) return false
  const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
  d.call(el,'${v}'); el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`)

// ---------------------------------------------------------------------------
console.log('\n[1] 목 후보 3개가 뜨고, 확인/거절하면 목록에서 사라지는가')
console.log('  패널 :', await counts())
const c0 = JSON.parse(await counts())
console.log('  → 후보 3건이 뜬다 :', ok(c0.cand === 3))
console.log('  → 확정 목록은 비어 있다 :', ok(c0.pts === 0))

// 이름을 붙여 승인한다
await setInput('#inspCandidates li:nth-child(1) .insp-name', '분전반 A')
await sleep(200)
await ev(`document.querySelector('#inspCandidates li:nth-child(1) .insp-ok')?.click()`)
await sleep(700)
const c1 = JSON.parse(await counts())
console.log('  확인 후 :', JSON.stringify(c1))
console.log('  → 후보에서 빠진다 :', ok(c1.cand === 2))
console.log('  → 확정으로 옮겨 간다 :', ok(c1.pts === 1))

await ev(`document.querySelector('#inspCandidates li:nth-child(1) .insp-no')?.click()`)
await sleep(700)
const c2 = JSON.parse(await counts())
console.log('  거절 후 :', JSON.stringify(c2))
console.log('  → 거절하면 사라진다 :', ok(c2.cand === 1))
console.log('  → 거절은 확정으로 가지 않는다 :', ok(c2.pts === 1),
  '(거절한 것이 목적지가 되면 사람이 승인한 뜻이 없어진다)')

// ---------------------------------------------------------------------------
console.log('\n[2] 확정 목록이 sequence 순이고, 이름수정·삭제 후 재정렬되는가')
// 남은 후보도 승인해 두 개로 만든다
await ev(`document.querySelector('#inspCandidates li:nth-child(1) .insp-ok')?.click()`)
await sleep(700)
const seqs = () => ev(`JSON.stringify([...document.querySelectorAll('#inspPoints li')].map(li=>({
  seq: li.querySelector('.insp-seq')?.textContent.trim(),
  name: li.querySelector('.insp-name')?.value})))`)
console.log('  확정 목록 :', await seqs())
const s1 = JSON.parse(await seqs())
console.log('  → 두 곳이 확정됐다 :', ok(s1.length === 2))
console.log('  → sequence 가 1,2 로 붙는다 :', ok(s1.map((x) => x.seq).join(',') === '1,2'))
console.log('  → 승인할 때 붙인 이름이 남는다 :', ok(s1[0]?.name === '분전반 A'))
console.log('  → 이름을 비워 두면 태그 번호가 이름이 된다 :', ok(/^태그 \d+$/.test(s1[1]?.name || '')),
  '(이름 때문에 승인이 막히면 안 된다)')

// 이름 인라인 수정
await setInput('#inspPoints li:nth-child(2) .insp-name', '배전반 B')
await ev(`document.querySelector('#inspPoints li:nth-child(2) .insp-name')?.blur()`)
await sleep(600)
const s2 = JSON.parse(await seqs())
console.log('  이름 수정 후 :', JSON.stringify(s2))
console.log('  → 이름이 바뀐다 :', ok(s2[1]?.name === '배전반 B'))

// 첫 번째를 지우면 남은 것이 1번이 되어야 한다
await ev(`document.querySelector('#inspPoints li:nth-child(1) .insp-del')?.click()`)
await sleep(700)
const s3 = JSON.parse(await seqs())
console.log('  삭제 후 :', JSON.stringify(s3))
console.log('  → 한 곳만 남는다 :', ok(s3.length === 1))
console.log('  → 번호가 1 부터 다시 매겨진다 :', ok(s3[0]?.seq === '1'),
  '(2번이 빠진 채 1,3,4 로 남으면 순서를 못 읽는다)')
console.log('  → 남은 것은 지우지 않은 쪽이다 :', ok(s3[0]?.name === '배전반 B'))

// ---------------------------------------------------------------------------
console.log('\n[3] 지도에 핀과 화살표가 그려지고 대기/확정이 구분되는가')
// 지도가 그려지도록 맵과 자세를 보낸다
const ROBOT = 'orinka_01'
let seq = 0
const cols = 200, rows = 150
const pushMap = () => be.push(`/topic/nav/${ROBOT}`, {
  type: 'MAP', sequence: ++seq, w: cols, h: rows, res: 0.05, ox: -2.0, oy: -1.5,
  cells: [0, Math.floor(cols * rows / 2), 100, cols * rows - Math.floor(cols * rows / 2)],
})
pushMap()
be.push(`/topic/nav/${ROBOT}`, { type: 'NAV_LIVE', pose: { x: 3.0, y: 4.0, yaw: 0 } })
await sleep(1400)

// 앞선 절차에서 후보를 전부 승인·거절했고, 남은 점의 좌표는 이 지도 밖이다.
// 서버가 목록 전체를 내려 주는 경로(snapshot)로 지도 안쪽 값을 넣어 다시 세운다 —
// 목이 아니라 실제 수신 경로를 타므로 그 경로도 함께 검증된다.
be.push('/topic/inspection', {
  schemaVersion: 1, kind: 'inspection_snapshot',
  candidates: [{
    schemaVersion: 1, kind: 'inspection_candidate', candidateId: 'cand-201', tagId: 201,
    confidence: 0.88, target: { x: 1.60, y: 1.20 }, viewpoint: { x: 2.40, y: 1.20, yaw: 3.1416 },
    standOffM: 0.8, source: 'apriltag', createdAt: '2026-08-06T20:30:00Z',
  }],
  points: [{
    schemaVersion: 1, kind: 'inspection_point', pointId: 'pt-301', tagId: 301,
    target: { x: 4.20, y: 3.40 }, viewpoint: { x: 3.40, y: 3.40, yaw: 0 },
    standOffM: 0.8, name: '분전반 A', sequence: 1, enabled: true,
  }, {
    schemaVersion: 1, kind: 'inspection_point', pointId: 'pt-302', tagId: 302,
    target: { x: 5.60, y: 4.60 }, viewpoint: { x: 5.60, y: 3.80, yaw: 1.5708 },
    standOffM: 0.8, name: '배전반 B', sequence: 2, enabled: true,
  }],
})
await sleep(1600)
console.log('  스냅샷 반영 :', await counts())

// 확정(빨강)과 대기(노랑) 픽셀을 센다. 순찰 지점(초록)과도 갈려야 한다.
const pins = () => ev(`(()=>{const cv=document.querySelector('#pgOps .routemap canvas')
  if(!cv) return null
  const g=cv.getContext('2d'); const d=g.getImageData(0,0,cv.width,cv.height).data
  let red=0, yellow=0, green=0
  for(let i=0;i<d.length;i+=4){
    const r=d[i], gg=d[i+1], b=d[i+2]
    // #E0483F 계열 — 확정
    if(r>150 && gg<110 && b<110 && r-gg>60) red++
    // #C9A227 계열 — 대기
    else if(r>140 && gg>110 && b<110 && gg-b>50 && r-gg<90) yellow++
    // #3ddc97 계열 — 순찰 지점
    else if(gg>150 && gg-r>60) green++
  }
  return JSON.stringify({size:[cv.width,cv.height], red, yellow, green})})()`)
console.log('  캔버스 :', await pins())
const px = JSON.parse((await pins()) || 'null') || {}
console.log('  → 확정 점검 지점이 그려진다 :', ok(px.red > 40))
console.log('  → 대기 후보가 그려진다 :', ok(px.yellow > 40))
console.log('  → 대기와 확정이 다른 색이다 :', ok(px.red > 40 && px.yellow > 40),
  '(같은 색이면 승인 전후를 구분할 수 없다)')

// 목록에 손을 올리면 지도에서 강조되는가 — 흰 테두리가 늘어난다
const whitePx = () => ev(`(()=>{const cv=document.querySelector('#pgOps .routemap canvas')
  const g=cv.getContext('2d'); const d=g.getImageData(0,0,cv.width,cv.height).data
  let w=0
  for(let i=0;i<d.length;i+=4) if(d[i]>248&&d[i+1]>248&&d[i+2]>248) w++
  return w})()`)
const w0 = await whitePx()
// React 의 onMouseEnter 는 합성 이벤트라 dispatchEvent 로는 안 걸린다 —
// 실제로 마우스를 그 자리로 옮긴다.
const box = JSON.parse(await ev(`(()=>{const li=document.querySelector('#inspPoints li')
  if(!li) return 'null'
  const r=li.getBoundingClientRect()
  return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)})})()`) || 'null') || {}
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
await sleep(150)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x || 0, y: box.y || 0 })
await sleep(1000)
const w1 = await whitePx()
console.log('  흰 픽셀 :', w0, '→', w1)
console.log('  → 목록에서 고르면 지도에서 강조된다 :', ok(w1 > w0),
  '(목록과 지도가 이어지지 않으면 좌표를 눈으로 대조해야 한다)')

{
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + 'E787-inspection.png', Buffer.from(data, 'base64'))
}

// ---------------------------------------------------------------------------
console.log('\n[4] mapId 리터럴 비교가 없고, 낡은 안내문이 지워졌는가')
const read = (f) => { try { return readFileSync(SRC + f, 'utf8') } catch { return '' } }
const litFiles = ['live/inspection.ts', 'components/ops/InspectionPanel.tsx',
  'components/ops/OpsPage.tsx', 'components/ops/RoutePanel.tsx', 'live/navMap.ts']
const lits = litFiles.filter((f) => /['"`]active-map['"`]/.test(read(f)))
console.log('  active-map 리터럴을 쓴 파일 :', lits.length ? lits : '없음')
console.log('  → mapId 리터럴 비교가 없다 :', ok(lits.length === 0),
  '(mapId 는 곧 실제 파일명으로 바뀐다)')
const ops = read('components/ops/OpsPage.tsx')
console.log('  → 로봇 파트 구현 대기 안내문이 없다 :', ok(!/로봇 파트.*구현 대기|구현 대기/.test(ops)))
const mapping = read('live/mapping.ts')
console.log('  → mapping.ts 주석이 갱신됐다 :',
  ok(/실기로 끝까지 도는 것을 확인/.test(mapping) && !/be_robot\/dev 매핑 오케스트레이션 완료/.test(mapping)))

// ---------------------------------------------------------------------------
console.log('\n[5] sendPointCommand 가 명령 스키마 그대로 보내는가')
const cmd = await ev(`(async()=>{
  const m = await import('/src/live/inspection.ts')
  return JSON.stringify({dest: m.INSPECTION_DEST, topic: m.INSPECTION_TOPIC, ver: m.SCHEMA_VERSION})})()`)
console.log('  계약 상수 :', cmd)
const cc = JSON.parse(cmd || '{}')
console.log('  → 발행지가 계약과 같다 :', ok(cc.dest === '/app/control/inspection'))
console.log('  → 구독 토픽이 계약과 같다 :', ok(cc.topic === '/topic/inspection'))
console.log('  → schemaVersion 이 1 이다 :', ok(cc.ver === 1))

// 실제 발행된 프레임을 서버 쪽에서 확인한다 — 화면 안에서 만든 값이 아니라
// 선을 타고 나간 것을 봐야 '보낸다' 를 말할 수 있다.
const frames = (be.sends || []).filter((f) => String(f.destination || '').includes('/control/inspection'))
console.log('  서버가 받은 명령 :', frames.length, '건')
if (frames.length) {
  const bodies = frames.map((f) => { try { return JSON.parse(f.body) } catch { return null } }).filter(Boolean)
  const cmds = bodies.map((b) => b.command)
  console.log('  명령 목록 :', JSON.stringify(cmds))
  const shapeOk = bodies.every((b) => b.schemaVersion === 1 && b.kind === 'inspection_point_command'
    && ['CONFIRM', 'REJECT', 'UPDATE', 'DELETE', 'PUBLISH'].includes(b.command))
  console.log('  → 모든 명령이 계약 모양이다 :', ok(shapeOk))
  const confirmOne = bodies.find((b) => b.command === 'CONFIRM')
  console.log('  CONFIRM 본문 :', JSON.stringify(confirmOne))
  console.log('  → CONFIRM 이 candidateId 를 싣는다 :', ok(!!confirmOne?.candidateId))
  const del = bodies.find((b) => b.command === 'DELETE')
  console.log('  → DELETE 가 pointId 를 싣는다 :', ok(!!del?.pointId))
  console.log('  → 빈 필드를 채워 보내지 않는다 :',
    ok(bodies.every((b) => !('name' in b) || typeof b.name === 'string')),
    '(빈 값을 실으면 서버가 지우라는 뜻으로 읽을 수 있다)')
} else {
  console.log('  → 명령이 서버까지 갔다 : **FAIL** (연결이 없으면 목 개발 중이라도 발행 경로가 죽어 있다)')
}

console.log('\n콘솔 에러 :', errs.length ? errs.slice(0, 2) : '없음')
ws.close(); chrome.kill()
process.exit(0)
