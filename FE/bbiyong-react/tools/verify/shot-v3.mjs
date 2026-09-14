// v3 디자인 적용 상태를 눈과 숫자로 함께 확인한다.
//
// 선언된 CSS 가 아니라 실제로 칠해진 값을 잰다 — v3-theme 이 붙어 있어도
// 안쪽 규칙이 구형 선택자에 밀리면 화면은 그대로다.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APP = process.env.APP_URL || 'http://localhost:5174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const be = await startFakeBackend(8099)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9477', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' })
let tg
for (let i = 0; i < 30; i++) {
  try { tg = await (await fetch('http://127.0.0.1:9477/json/list')).json(); if (tg.length) break } catch {}
  await sleep(500)
}
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pend = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
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

const probe = `(()=>{
  const px=(v)=>Math.round(parseFloat(v)||0)
  const g=(sel,fn)=>{const e=document.querySelector(sel); return e?fn(getComputedStyle(e),e):null}
  const page=[...document.querySelectorAll('.page.on')].find(p=>p.getBoundingClientRect().height>0 && p.closest('[hidden]')===null)
  const q=(sel)=>page?[...page.querySelectorAll(sel)]:[]
  const cards=q('.card-v3, .panel')
  return {
    page: page?.id,
    v3: !!page?.classList.contains('v3-theme'),
    pageBg: page?getComputedStyle(page).backgroundImage.slice(0,60):null,
    title: (()=>{const e=page?.querySelector('.nav-title h2'); if(!e) return null
      const s=getComputedStyle(e); return {size:px(s.fontSize),weight:s.fontWeight,color:s.color,ls:s.letterSpacing,font:s.fontFamily.split(',')[0]}})(),
    kpi: (()=>{const e=page?.querySelector('.kpi-num'); if(!e) return null
      const s=getComputedStyle(e); return {size:px(s.fontSize),weight:s.fontWeight,font:s.fontFamily.split(',')[0]}})(),
    kpiLabel: (()=>{const e=page?.querySelector('.kpi-label'); if(!e) return null
      const s=getComputedStyle(e); return {size:px(s.fontSize),color:s.color,borderBottom:s.borderBottomStyle}})(),
    cardCount: cards.length,
    card: cards[0]?(()=>{const s=getComputedStyle(cards[0]);return{cls:cards[0].className,bg:s.backgroundColor,radius:px(s.borderTopLeftRadius),shadow:s.boxShadow.slice(0,44),border:s.borderTopWidth}})():null,
    fonts: [...new Set(cards.slice(0,6).map(c=>getComputedStyle(c).fontFamily.split(',')[0]))],
    monoCount: q('.mono, .kpiN').length,
    fontLoaded: {gothic: document.fonts.check('700 32px "Gothic A1"'), plex: document.fonts.check('600 14px "IBM Plex Mono"')},
    legacyPanel: q('.panel').length,
    v3Cards: q('.card-v3').length,
    contrast: (()=>{
      const nums=(c)=>c.slice(c.indexOf('(')+1, c.indexOf(')')).split(',').map(x=>parseFloat(x))
      const lum=(c)=>{const p=nums(c)
        const f=(v)=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}
        return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2])}
      const solid=(c)=>{const p=nums(c); return p.length<4 || p[3]>0.95}
      const opaque=(el)=>{let e=el
        while(e){const b=getComputedStyle(e).backgroundColor
          if(b && b!=='transparent' && solid(b)) return b
          e=e.parentElement}
        return 'rgb(255,255,255)'}
      const pick=[['제목','.nav-title h2'],['부제','.nav-sub'],['KPI 숫자','.kpi-num'],['KPI 라벨','.kpi-label'],
        ['카드 제목','.card-v3 h3'],['본문','.cfg-help'],['로그 시각','.logtime'],['로그 본문','.logtext'],
        ['요약 라벨','.sumcard > span'],['요약 값','.sumcard > b'],['kv 라벨','.kv span'],['kv 값','.kv b']]
      const out={}
      for(const pr of pick){const e=page&&page.querySelector(pr[1]); if(!e) continue
        const st=getComputedStyle(e); const L1=lum(st.color), L2=lum(opaque(e))
        out[pr[0]]=Math.round(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05))*100)/100}
      return out})(),
    hero: (()=>{const h=page&&page.querySelector('.nav-hero'); if(!h) return null
      const s=getComputedStyle(h); const k=page.querySelector('.kpis')
      const ks=k?getComputedStyle(k):null
      const r=(e)=>{const b=e.getBoundingClientRect(); return [Math.round(b.left),Math.round(b.width)]}
      const b1=page.querySelector('.kpi-badge')
      return {heroDisplay:s.display, heroCols:s.gridTemplateColumns, heroAlign:s.alignItems,
        kpis:ks?{display:ks.display, cols:ks.gridTemplateColumns, gap:ks.columnGap}:null,
        kpisBox:k?r(k):null, titleBox:r(page.querySelector('.nav-title')),
        badge:b1?(()=>{const bs=getComputedStyle(b1); return {w:bs.width,h:bs.height,radius:bs.borderTopLeftRadius,text:(b1.textContent||'').trim()}})():null}})(),
    ops: (()=>{if(page?.id!=='pgOps') return null
      const t=(sel)=>{const e=page.querySelector(sel); if(!e) return null
        const b=e.getBoundingClientRect(); return {top:Math.round(b.top),left:Math.round(b.left),h:Math.round(b.height)}}
      const st=page.querySelector('.nav-stage')
      return {stage:getComputedStyle(st).alignItems, side:t('.nav-side'), sideCard:t('.nav-side .card-v3'),
        canvas:t('.nav-canvas'), route:t('.nav-canvas .card-v3'),
        routeMargin:(()=>{const e=page.querySelector('.nav-canvas .card-v3'); return e?getComputedStyle(e).marginTop:null})()}})(),
    log: (()=>{const row=page&&(page.querySelector('.elog li')||page.querySelector('.logrow')); if(!row) return null
      const px=(v)=>Math.round(parseFloat(v)||0)
      const rs=getComputedStyle(row)
      const dot=row.querySelector('i,.logdot')
      const t=row.querySelector('.t,.logtime')
      const b=row.querySelector('b,.logtext')
      const act=row.querySelector('button')
      const one=(e)=>{if(!e) return null; const c=getComputedStyle(e)
        return {size:px(c.fontSize), weight:c.fontWeight, color:c.color, font:c.fontFamily.split(',')[0],
          w:px(c.width), h:px(c.height), radius:px(c.borderTopLeftRadius), bg:c.backgroundColor}}
      return {rowCls:row.className, pad:rs.padding, gap:rs.columnGap, display:rs.display, align:rs.alignItems,
        borderBottom:rs.borderBottomWidth+' '+rs.borderBottomColor, bg:rs.backgroundColor,
        dot:one(dot), time:one(t), text:one(b), act:act?{cls:act.className, opacity:getComputedStyle(act).opacity}:null}})(),
    btns: q('button').slice(0,40).map(b=>{const s=getComputedStyle(b)
      return {t:(b.textContent||'').trim().slice(0,10), cls:b.className.slice(0,26), bg:s.backgroundColor, r:px(s.borderTopLeftRadius)}}),
  }})()`

const goTab = async (label) => {
  await ev(`[...document.querySelectorAll('#nav .navtabs button')].find(b=>b.textContent.trim()==='${label}')?.click()`)
  await sleep(1200)
}

for (const tab of ['지도', '카메라', '이벤트', '통계', '운영', '설정']) {
  await goTab(tab)
  const r = await ev(probe)
  console.log(`\n===== ${tab} =====`)
  console.log('  page :', r?.page, '· v3-theme :', r?.v3)
  console.log('  배경 :', r?.pageBg)
  console.log('  제목 :', JSON.stringify(r?.title))
  console.log('  카드 :', r?.v3Cards, 'v3 /', r?.legacyPanel, '구형panel · 첫 카드', JSON.stringify(r?.card))
  console.log('  폰트 :', JSON.stringify(r?.fonts))
  console.log('  mono :', r?.monoCount, '개 · KPI', JSON.stringify(r?.kpi), '라벨', JSON.stringify(r?.kpiLabel))
  const c=r?.contrast||{}
  if (r?.ops) console.log('  운영 배치 :', JSON.stringify(r.ops))
  if (r?.log) console.log('  로그 :', JSON.stringify(r.log))
  console.log('  히어로 :', JSON.stringify(r?.hero))
  console.log('  대비 :', Object.entries(c).map(([k,v])=>k+' '+v).join(' · '))
  const bad=Object.entries(c).filter(([,v])=>v<4.5)
  console.log('  → 4.5 미달 :', bad.length?bad.map(([k,v])=>k+' '+v).join(', '):'없음')
  const odd = (r?.btns || []).filter((b) => !/rgba\(0, 0, 0, 0\)|76, 86, 149|228, 229, 245|192, 122, 114/.test(b.bg) || b.r !== 20)
  console.log('  v3 규격 밖 버튼 :', odd.length, '/', r?.btns?.length)
  odd.slice(0, 6).forEach((b) => console.log('     ·', b.t, '|', b.cls, '|', b.bg, '| r' + b.r))
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + `V3-${tab}.png`, Buffer.from(data, 'base64'))
}

ws.close(); chrome.kill()
process.exit(0)
