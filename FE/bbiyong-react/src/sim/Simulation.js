// Simulation — 원본 index.html의 vanilla JS(IIFE)를 프레임워크 독립적인
// 컨트롤러로 이식. Canvas 실시간 렌더링(rAF)과 상태 머신을 담당하고,
// UI에 필요한 값은 subscribe(snapshot) 로 React에 밀어준다.

import { MAP, RS, CSn, astar, loop, PANELS, FIREC, speed } from './mapData.js'

// 캔버스를 부모 크기에 맞추고 2D 컨텍스트를 반환
function fit(cv) {
  const r = cv.parentElement.getBoundingClientRect()
  if (cv.width !== Math.round(r.width) || cv.height !== Math.round(r.height)) {
    cv.width = Math.round(r.width)
    cv.height = Math.round(r.height)
  }
  return cv.getContext('2d')
}

const nowStr = () => new Date().toTimeString().slice(0, 8)

export default class Simulation {
  constructor() {
    // ---- 공통 상태 ----
    this.t = 0
    this.fireOn = false
    this.heatOn = false
    this.soundOn = true
    this.currentTab = 'robot' // 'cctv' | 'robot' — 순찰 로봇 관제가 첫 페이지

    // ---- CCTV / PTZ ----
    this.ptz = { x: 0, y: 0, z: 1 }
    this.conf = new Array(48).fill(0)
    this.det = { flameState: '미발생', flamePct: '0%', smokeState: '미발생', smokePct: '0%' }

    // ---- 로봇 ----
    this.bot = { pos: { c: 0, r: 0 }, seg: 0, prog: 0, mode: 'patrol', route: [], rs: 0, rp: 0, hd: 0 }
    this.seg = 'patrol' // 순찰 모드 세그먼트 표시용
    this.modeText = '순찰 중'
    this.modeClass = ''
    this.spd = '0.6 m/s'
    this.rcamHud = 'MODE PATROL · MAP OK'
    this.batt = 87
    this.bt = 0
    this.envT = '24.6°C'
    this.envH = '41%'
    this.switches = { power: true, light: false, ultra: true, siren: false }

    // ---- 열화상 ----
    this.heatT = 38.4
    this.thermalMax = 'MAX 38.4°C'
    this.thermalColor = '#b9ffe0'

    // ---- 로그 ----
    this.logs = []
    this.logId = 0

    // ---- 캔버스 레지스트리 / 구독 ----
    this.canvases = {}
    this.listeners = new Set()

    // ---- 실서버(live) 외부 입력 ----
    // 값이 있으면 시뮬 상태머신 대신 실제 로봇의 위치/영상을 그린다.
    // null이면 기존 시뮬레이션 동작 그대로 (mock 모드).
    this.externalPose = null              // { c, r, hd }
    this.externalFrames = { FRONT: null, THERMAL: null } // { img, maxTemp }

    this._raf = null
    this._emitTimer = null
    this._started = false

    // 메서드 바인딩 (rAF/이벤트에서 안전하게 사용)
    this.tick = this.tick.bind(this)
  }

  // ---------- 라이프사이클 ----------
  registerCanvas(name, el) { this.canvases[name] = el }

  subscribe(fn) {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => this.listeners.delete(fn)
  }

  start() {
    if (this._started) return
    this._started = true
    if (this.logs.length === 0) this.pushLog('ok', '시스템 시작 — 상시 순찰 개시')
    this._emitTimer = setInterval(() => this.emit(), 400)
    this._raf = requestAnimationFrame(this.tick)
  }

  stop() {
    this._started = false
    if (this._raf) cancelAnimationFrame(this._raf)
    if (this._emitTimer) clearInterval(this._emitTimer)
    this._raf = this._emitTimer = null
  }

  // ---------- 스냅샷 / 방출 ----------
  snapshot() {
    return {
      fireOn: this.fireOn,
      heatOn: this.heatOn,
      soundOn: this.soundOn,
      ptz: { ...this.ptz },
      det: { ...this.det },
      seg: this.seg,
      modeText: this.modeText,
      modeClass: this.modeClass,
      spd: this.spd,
      rcamHud: this.rcamHud,
      batt: this.batt,
      envT: this.envT,
      envH: this.envH,
      switches: { ...this.switches },
      thermalMax: this.thermalMax,
      thermalColor: this.thermalColor,
      logs: this.logs,
    }
  }

  emit() {
    const snap = this.snapshot()
    this.listeners.forEach((fn) => fn(snap))
  }

  pushLog(kind, msg) {
    this.logs = [{ id: ++this.logId, kind, time: nowStr(), msg }, ...this.logs].slice(0, 100)
    this.emit()
  }

  setTab(tab) { this.currentTab = tab }

  // 결정적 유사난수 (텍스처·노이즈용, Math.random 미사용)
  _hash(a, b) { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s) }

  // ---------- 공장 CCTV 카메라 (관제 전체 뷰 · 3/4 부감) ----------
  // 참고: BBIYONG_simulation_v3 의 camL(높이 34·반경 50·피치 ~34° 부감 회전)을
  // 3D 투영으로 재현 — 공장 전체를 비스듬히 내려다보며 압출 박스(분전반·로봇·설비)와
  // 원거리 벽·순찰 경로·화재를 깊이 정렬로 그린다. PTZ(off)로 회전/틸트/줌.
  drawFactoryCam(cv, off) {
    const g = fit(cv), Wc = cv.width, Hc = cv.height, t = this.t
    const zoom = off ? Math.min(2.4, Math.max(1, off.z)) : 1
    const yaw = 0.66 + (off ? off.x * 0.05 : 0) + Math.sin(t * 0.0004) * 0.05 // 코너각 + 팬 + 완만한 회전
    const pitch = Math.max(0.42, Math.min(0.95, 0.62 - (off ? off.y * 0.02 : 0)))
    const CAMD = 13
    const cyA = Math.cos(yaw), syA = Math.sin(yaw), cpA = Math.cos(pitch), spA = Math.sin(pitch)
    const cxw = (CSn - 1) / 2, czw = (RS - 1) / 2
    const raw = (c, wy, r) => {
      const x = c - cxw, z = r - czw
      const rx = x * cyA - z * syA, rz = x * syA + z * cyA
      // 카메라 하향 피치: 먼 쪽(rz 큼)이 화면 위로, 박스는 위로 압출 (부호 정정)
      const ry = wy * cpA + rz * spA, rz2 = -wy * spA + rz * cpA
      const zc = rz2 + CAMD
      return { X: rx / zc, Y: ry / zc, zc }
    }
    // 오토핏: 공장 바운딩(바닥 4모서리 × 높이 0/2)으로 스케일·센터 산출
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
    for (const c of [-0.5, CSn - 0.5]) for (const r of [-0.5, RS - 0.5]) for (const h of [0, 2.3]) {
      const q = raw(c, h, r); if (q.X < minX) minX = q.X; if (q.X > maxX) maxX = q.X; if (q.Y < minY) minY = q.Y; if (q.Y > maxY) maxY = q.Y
    }
    const scale = Math.min(Wc * 0.92 / (maxX - minX), Hc * 0.92 / (maxY - minY)) * zoom
    const cxn = (minX + maxX) / 2, cyn = (minY + maxY) / 2, ox = Wc / 2, oy = Hc / 2
    const P = (c, wy, r) => { const q = raw(c, wy, r); return { x: ox + (q.X - cxn) * scale, y: oy - (q.Y - cyn) * scale, s: scale / q.zc, zc: q.zc } }
    const lerp2 = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f })

    // 압출 박스(측면 근접순 → 윗면)
    const box = (c, r, hw, hd, H, side, top) => {
      const base = [[c - hw, r - hd], [c + hw, r - hd], [c + hw, r + hd], [c - hw, r + hd]]
      const bp = base.map(([x, z]) => P(x, 0, z)), tp = base.map(([x, z]) => P(x, H, z))
      const faces = []
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; faces.push({ zc: (bp[i].zc + bp[j].zc) / 2, q: [bp[i], bp[j], tp[j], tp[i]] }) }
      faces.sort((a, b) => b.zc - a.zc)
      g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1
      faces.forEach((fc) => { g.fillStyle = side; g.beginPath(); fc.q.forEach((p, k) => k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.fill(); g.stroke() })
      g.fillStyle = top; g.beginPath(); tp.forEach((p, k) => k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.fill(); g.stroke()
      return { bp, tp, front: faces[faces.length - 1].q, cen: P(c, H, r) }
    }
    const shadow = (c, r, rw) => { const p = P(c, 0, r); g.fillStyle = 'rgba(0,0,0,.30)'; g.beginPath(); g.ellipse(p.x, p.y, rw * p.s, rw * p.s * 0.5, 0, 0, 7); g.fill() }

    // 배경
    const sky = g.createLinearGradient(0, 0, 0, Hc)
    sky.addColorStop(0, '#0b0e13'); sky.addColorStop(1, '#171c23')
    g.fillStyle = sky; g.fillRect(0, 0, Wc, Hc)

    // 바닥
    const f00 = P(-0.5, 0, -0.5), f10 = P(CSn - 0.5, 0, -0.5), f11 = P(CSn - 0.5, 0, RS - 0.5), f01 = P(-0.5, 0, RS - 0.5)
    const fgrad = g.createLinearGradient(f00.x, f00.y, f11.x, f11.y)
    fgrad.addColorStop(0, '#2b323b'); fgrad.addColorStop(1, '#191d23')
    g.fillStyle = fgrad; g.beginPath(); g.moveTo(f00.x, f00.y); g.lineTo(f10.x, f10.y); g.lineTo(f11.x, f11.y); g.lineTo(f01.x, f01.y); g.closePath(); g.fill()
    // 바닥 격자
    g.strokeStyle = 'rgba(88,100,118,.30)'; g.lineWidth = 1
    for (let c = 0; c <= CSn; c++) { const a = P(c - 0.5, 0, -0.5), b = P(c - 0.5, 0, RS - 0.5); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }
    for (let r = 0; r <= RS; r++) { const a = P(-0.5, 0, r - 0.5), b = P(CSn - 0.5, 0, r - 0.5); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }

    // CCTV 코너 조명 콘 (참고 이미지의 앰버 광원)
    const chead = P(CSn - 0.7, 1.7, -0.2), cpole = P(CSn - 0.7, 0, -0.2)
    const poolC = P(6, 0.02, 3.4)
    const pool = g.createRadialGradient(poolC.x, poolC.y, 4, poolC.x, poolC.y, Wc * 0.34)
    pool.addColorStop(0, 'rgba(224,169,59,.13)'); pool.addColorStop(1, 'rgba(224,169,59,0)')
    g.fillStyle = pool; g.beginPath(); g.ellipse(poolC.x, poolC.y, Wc * 0.34, Wc * 0.20, 0, 0, 7); g.fill()
    const cbL = P(3, 0.02, 2), cbR = P(9.5, 0.02, 5)
    const cone = g.createLinearGradient(chead.x, chead.y, poolC.x, poolC.y)
    cone.addColorStop(0, 'rgba(224,169,59,.16)'); cone.addColorStop(1, 'rgba(224,169,59,0)')
    g.fillStyle = cone; g.beginPath(); g.moveTo(chead.x, chead.y); g.lineTo(cbL.x, cbL.y); g.lineTo(cbR.x, cbR.y); g.closePath(); g.fill()

    // 원거리 벽 2개 (근접 벽은 생략해 내부 시야 확보)
    const walls = [
      { c: cxw, r: -0.6, hw: CSn / 2 + 0.1, hd: 0.12 }, { c: cxw, r: RS - 0.4, hw: CSn / 2 + 0.1, hd: 0.12 },
      { c: -0.6, r: czw, hw: 0.12, hd: RS / 2 + 0.1 }, { c: CSn - 0.4, r: czw, hw: 0.12, hd: RS / 2 + 0.1 },
    ]
    walls.forEach((w) => { w.zc = raw(w.c, 0, w.r).zc }); walls.sort((a, b) => b.zc - a.zc)
    for (let i = 0; i < 2; i++) { const w = walls[i]; box(w.c, w.r, w.hw, w.hd, 1.7, '#333b46', '#464f5c') }

    // 순찰 경로(파랑 점선) + 긴급 경로(초록)
    g.strokeStyle = 'rgba(63,143,224,.75)'; g.setLineDash([5, 4]); g.lineWidth = 1.6; g.beginPath()
    loop.forEach((p, i) => { const q = P(p.c, 0.04, p.r); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y) })
    const q0 = P(loop[0].c, 0.04, loop[0].r); g.lineTo(q0.x, q0.y); g.stroke(); g.setLineDash([])
    if ((this.bot.mode === 'dispatch' || this.bot.mode === 'goto') && this.bot.route.length > 1) {
      g.strokeStyle = '#22b98a'; g.lineWidth = 2.4; g.beginPath()
      this.bot.route.forEach((p, i) => { const q = P(p.c, 0.05, p.r); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y) }); g.stroke()
    }

    // 분전반: 벽면 부착 지오메트리 (내측 면 인덱스 face·안쪽 방향 inC/inR)
    const panelGeos = PANELS.map((pn) => {
      if (pn.r <= 0) return { pn, c: pn.c, r: -0.26, hw: 0.5, hd: 0.22, face: [2, 3], inC: 0, inR: 1 }             // 뒤벽 · 내측 +r
      if (pn.r >= RS - 1) return { pn, c: pn.c, r: RS - 1 + 0.26, hw: 0.5, hd: 0.22, face: [0, 1], inC: 0, inR: -1 } // 앞벽 · 내측 -r
      if (pn.c >= CSn - 1) return { pn, c: CSn - 1 + 0.26, r: pn.r, hw: 0.22, hd: 0.5, face: [3, 0], inC: -1, inR: 0 } // 우벽 · 내측 -c
      return { pn, c: -0.26, r: pn.r, hw: 0.22, hd: 0.5, face: [1, 2], inC: 1, inR: 0 }                              // 좌벽 · 내측 +c
    })

    // 내부 오브젝트 depth-sort (먼 것 → 가까운 것)
    const items = []
    for (let r = 0; r < RS; r++) for (let c = 0; c < CSn; c++) if (MAP[r][c] === 1) items.push({ zc: raw(c, 0, r).zc, kind: 'obs', c, r })
    panelGeos.forEach((geo) => items.push({ zc: raw(geo.c, 0, geo.r).zc, kind: 'panel', geo }))
    items.push({ zc: raw(this.bot.pos.c, 0, this.bot.pos.r).zc, kind: 'robot' })
    if (this.fireOn) items.push({ zc: raw(FIREC.c, 0, FIREC.r).zc, kind: 'fire' })
    items.sort((a, b) => b.zc - a.zc)

    items.forEach((it) => {
      if (it.kind === 'obs') { const oh = 1.05 + this._hash(it.c * 2 + 1, it.r * 3 + 2) * 0.85; shadow(it.c, it.r, 0.42); box(it.c, it.r, 0.36, 0.36, oh, '#141922', '#1e2530') }
      else if (it.kind === 'panel') {
        const geo = it.geo, pn = geo.pn, hot = this.heatOn && pn.n === 'B'
        // 안쪽 바닥 조명(불빛이 공장 안쪽을 향함)
        const gp = P(geo.c + geo.inC * 0.75, 0.02, geo.r + geo.inR * 0.75)
        const glow = g.createRadialGradient(gp.x, gp.y, 2, gp.x, gp.y, Math.max(16, 0.55 * gp.s))
        glow.addColorStop(0, hot ? 'rgba(255,86,72,.30)' : 'rgba(55,192,142,.22)'); glow.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = glow; g.beginPath(); g.ellipse(gp.x, gp.y, Math.max(16, 0.55 * gp.s), Math.max(8, 0.28 * gp.s), 0, 0, 7); g.fill()
        shadow(geo.c, geo.r, Math.max(geo.hw, geo.hd) + 0.05)
        const bx = box(geo.c, geo.r, geo.hw, geo.hd, 1.7, '#6d7686', '#8b93a0')
        // 내측(안쪽) 면 = 도어·스트라이프·LED. 카메라에서 보일 때만 그린다.
        const [ia, ib] = geo.face
        const bA = bx.bp[ia], bB = bx.bp[ib], tA = bx.tp[ia], tB = bx.tp[ib]
        const fzc = (bA.zc + bB.zc + tA.zc + tB.zc) / 4
        if (fzc < bx.cen.zc + 0.2) {
          const mA = lerp2(tA, bA, 0.16), mB = lerp2(tB, bB, 0.16)
          g.fillStyle = hot ? '#ef5648' : '#E0A93B'; g.beginPath(); g.moveTo(tA.x, tA.y); g.lineTo(tB.x, tB.y); g.lineTo(mB.x, mB.y); g.lineTo(mA.x, mA.y); g.closePath(); g.fill()
          const dTA = lerp2(lerp2(mA, mB, 0.15), lerp2(bA, bB, 0.15), 0.06), dTB = lerp2(lerp2(mA, mB, 0.85), lerp2(bA, bB, 0.85), 0.06)
          const dBA = lerp2(lerp2(mA, mB, 0.15), lerp2(bA, bB, 0.15), 0.92), dBB = lerp2(lerp2(mA, mB, 0.85), lerp2(bA, bB, 0.85), 0.92)
          g.fillStyle = '#565e6b'; g.beginPath(); g.moveTo(dTA.x, dTA.y); g.lineTo(dTB.x, dTB.y); g.lineTo(dBB.x, dBB.y); g.lineTo(dBA.x, dBA.y); g.closePath(); g.fill()
          const led = lerp2(lerp2(tA, tB, 0.16), lerp2(bA, bB, 0.16), 0.22)
          g.fillStyle = hot ? '#ff5648' : '#37c08e'; g.beginPath(); g.arc(led.x, led.y, Math.max(1.8, 0.07 * bx.cen.s), 0, 7); g.fill()
        }
        g.fillStyle = '#dfe4ea'; g.font = `${Math.min(16, Math.max(9, Math.round(0.42 * bx.cen.s)))}px Consolas,monospace`; g.textAlign = 'center'
        g.fillText('분전반 ' + pn.n + (hot ? ' ⚠' : ''), bx.cen.x, bx.cen.y - 6); g.textAlign = 'left'
      }
      else if (it.kind === 'robot') {
        // 오린카 (시뮬레이션 참고): 녹색 섀시 + 어두운 센서 상단부 + 전방 카메라 + 4바퀴 + 앰버 비콘
        // 진행 방향(hd)으로 회전 — 전방(f) / 측방(s) 로컬축을 그리드로 변환
        const bc = this.bot.pos.c, br = this.bot.pos.r, hd = this.bot.hd
        const ch = Math.cos(hd), sh = Math.sin(hd)
        const pt = (f, s) => ({ c: bc + f * ch - s * sh, r: br + f * sh + s * ch })
        const rbox = (f0, f1, s0, s1, y0, H, side, top) => {
          const base = [pt(f1, s0), pt(f1, s1), pt(f0, s1), pt(f0, s0)]
          const bp = base.map((p) => P(p.c, y0, p.r)), tp = base.map((p) => P(p.c, y0 + H, p.r))
          const faces = []
          for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; faces.push({ zc: (bp[i].zc + bp[j].zc) / 2, q: [bp[i], bp[j], tp[j], tp[i]] }) }
          faces.sort((a, b) => b.zc - a.zc)
          g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1
          faces.forEach((fc) => { g.fillStyle = side; g.beginPath(); fc.q.forEach((p, k) => k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.fill(); g.stroke() })
          g.fillStyle = top; g.beginPath(); tp.forEach((p, k) => k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.fill(); g.stroke()
        }
        shadow(bc, br, 0.52)
        // 바퀴 4개 (검정)
        ;[[0.26, -1], [0.26, 1], [-0.26, -1], [-0.26, 1]].forEach(([f, ss]) => rbox(f - 0.1, f + 0.1, ss * 0.34 - 0.06, ss * 0.34 + 0.06, 0, 0.18, '#0e1216', '#171d24'))
        // 섀시(녹색, 전방으로 긴 박스)
        rbox(-0.42, 0.42, -0.3, 0.3, 0.12, 0.36, '#2f9e77', '#3ddc97')
        // 상단 센서 박스(어두움, 뒤쪽)
        rbox(-0.3, 0.06, -0.2, 0.2, 0.48, 0.34, '#182029', '#243040')
        // 전방 카메라 (청록 발광)
        const cam = P(pt(0.5, 0).c, 0.34, pt(0.5, 0).r)
        g.fillStyle = 'rgba(55,220,151,.4)'; g.beginPath(); g.arc(cam.x, cam.y, Math.max(4, 0.16 * cam.s), 0, 7); g.fill()
        g.fillStyle = '#9fe6cf'; g.beginPath(); g.arc(cam.x, cam.y, Math.max(2, 0.09 * cam.s), 0, 7); g.fill()
        // 비콘 (앰버, 상단 뒤쪽 · 출동 시 점등)
        const bk = P(pt(-0.16, 0).c, 0.94, pt(-0.16, 0).r)
        const beaconOn = this.bot.mode === 'dispatch' || this.modeClass === 'emg'
        if (beaconOn) { g.fillStyle = 'rgba(239,159,39,.35)'; g.beginPath(); g.arc(bk.x, bk.y, Math.max(6, 0.32 * bk.s), 0, 7); g.fill() }
        g.fillStyle = beaconOn ? '#ef9f27' : '#e0a93b'; g.beginPath(); g.arc(bk.x, bk.y, Math.max(2, 0.12 * bk.s), 0, 7); g.fill()
      }
      else if (it.kind === 'fire') {
        const f = P(FIREC.c, 0, FIREC.r), u = f.s, pu = (Math.sin(t * .15) + 1) / 2
        g.strokeStyle = `rgba(226,75,74,${.4 + pu * .5})`; g.lineWidth = 2
        g.beginPath(); g.ellipse(f.x, f.y, 0.7 * u, 0.35 * u, 0, 0, 7); g.stroke()
        const gl = g.createRadialGradient(f.x, f.y - 0.5 * u, 2, f.x, f.y - 0.5 * u, 1.3 * u)
        gl.addColorStop(0, 'rgba(255,140,40,.5)'); gl.addColorStop(1, 'rgba(255,140,40,0)')
        g.fillStyle = gl; g.beginPath(); g.arc(f.x, f.y - 0.5 * u, 1.3 * u, 0, 7); g.fill()
        for (let i = 0; i < 6; i++) {
          const fl = Math.sin(t * .25 + i * 1.7) * .5 + .5
          g.fillStyle = `rgba(${230 + i * 4},${90 + i * 22},30,${.5 + fl * .4})`
          const b0 = f.x + (i - 2.5) * 0.14 * u
          g.beginPath(); g.moveTo(b0 - 0.12 * u, f.y); g.quadraticCurveTo(b0 + Math.sin(t * .3 + i) * 0.12 * u, f.y - (1.0 + fl * 0.6) * u, b0 + 0.12 * u, f.y); g.fill()
        }
        const bw = 1.1 * u, bh = 1.3 * u
        g.strokeStyle = '#ff5648'; g.lineWidth = 2; g.strokeRect(f.x - bw / 2, f.y - bh, bw, bh)
        g.fillStyle = '#ff5648'; g.fillRect(f.x - bw / 2, f.y - bh - 14, 96, 13)
        g.fillStyle = '#fff'; g.font = '700 10px Consolas,monospace'; g.fillText('fire 0.62 · smoke 0.31', f.x - bw / 2 + 2, f.y - bh - 4)
      }
    })

    // 코너 CCTV 카메라(앰버) + 화재 감지선 (chead/cpole 은 위에서 계산)
    g.strokeStyle = '#6a7280'; g.lineWidth = Math.max(2, 0.14 * chead.s); g.beginPath(); g.moveTo(cpole.x, cpole.y); g.lineTo(chead.x, chead.y); g.stroke()
    g.fillStyle = '#2b2f36'; g.beginPath(); g.arc(chead.x, chead.y, Math.max(3, 0.22 * chead.s), 0, 7); g.fill()
    g.fillStyle = '#E0A93B'; g.beginPath(); g.arc(chead.x + 3, chead.y + 2, Math.max(1.5, 0.1 * chead.s), 0, 7); g.fill()
    if (this.fireOn) {
      const ft = P(FIREC.c, 0.6, FIREC.r)
      g.strokeStyle = 'rgba(224,169,59,.8)'; g.setLineDash([4, 3]); g.lineWidth = 1.4
      g.beginPath(); g.moveTo(chead.x, chead.y); g.lineTo(ft.x, ft.y); g.stroke(); g.setLineDash([])
    }

    // CCTV 오버레이 (비네트 + 스캔라인 + 라벨)
    const vig = g.createRadialGradient(Wc / 2, Hc / 2, Hc * 0.32, Wc / 2, Hc / 2, Hc * 0.78)
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.42)')
    g.fillStyle = vig; g.fillRect(0, 0, Wc, Hc)
    g.fillStyle = 'rgba(255,255,255,.022)'; for (let y = (t % 4); y < Hc; y += 4) g.fillRect(0, y, Wc, 1)
    g.fillStyle = 'rgba(185,232,255,.85)'; g.font = '11px Consolas,monospace'
    g.fillText('CH01 · 공장 CCTV · 관제 전체 뷰', 10, 18)
    g.fillStyle = '#ff7d74'; g.beginPath(); g.arc(Wc - 52, 15, 3.5, 0, 7); g.fill()
    g.fillStyle = 'rgba(255,180,180,.9)'; g.fillText('REC', Wc - 44, 18)
  }

  // ---------- 신뢰도 차트 ----------
  drawConf() {
    const cv = this.canvases.conf; if (!cv) return
    const g = fit(cv), Wc = cv.width, Hc = cv.height
    g.clearRect(0, 0, Wc, Hc)
    const L = 34, B = 18, T = 8
    g.strokeStyle = '#e7ebf1'; g.lineWidth = 1; g.fillStyle = '#98a2b0'; g.font = '10px Consolas,monospace'
    for (let i = 0; i <= 5; i++) {
      const y = T + (Hc - T - B) * (1 - i / 5)
      g.beginPath(); g.moveTo(L, y); g.lineTo(Wc - 6, y); g.stroke()
      g.fillText(String(i * 20).padStart(3, ' '), 4, y + 3)
    }
    for (let i = 0; i <= 8; i++) {
      const x = L + (Wc - L - 10) * i / 8
      g.fillText((i * 3).toString().padStart(2, '0') + ':00', x - 10, Hc - 4)
    }
    g.strokeStyle = '#e2483d'; g.lineWidth = 2; g.beginPath()
    this.conf.forEach((v, i) => {
      const x = L + (Wc - L - 10) * i / (this.conf.length - 1), y = T + (Hc - T - B) * (1 - v / 100)
      i ? g.lineTo(x, y) : g.moveTo(x, y)
    })
    g.stroke()
    const li = this.conf.findIndex((v) => v > 5)
    if (li >= 0) {
      const x = L + (Wc - L - 10) * li / (this.conf.length - 1), y = T + (Hc - T - B) * (1 - this.conf[li] / 100)
      g.fillStyle = '#e2483d'; g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill()
    }
  }

  // ---------- 확대 화면 ----------
  drawBig() {
    const cv = this.canvases.bigcam; if (!cv) return
    const g = fit(cv)
    const src = this.canvases.cam3
    if (src && src.width > 0) g.drawImage(src, 0, 0, cv.width, cv.height)
  }

  // ---------- 실서버 외부 입력 ----------
  // live 모드에서 텔레메트리 위치를 격자 좌표로 변환해 넣는다. null이면 시뮬 상태머신으로 복귀.
  setExternalPose(pose) {
    this.externalPose = pose
    if (!pose) this.botResume()
  }

  // live 모드 카메라 프레임. img는 디코딩이 끝난 HTMLImageElement.
  setExternalFrame(channel, img, maxTemp) {
    if (channel !== 'FRONT' && channel !== 'THERMAL') return
    this.externalFrames[channel] = img ? { img, maxTemp } : null
  }

  clearExternalFrames() { this.externalFrames = { FRONT: null, THERMAL: null } }

  // 캔버스를 꽉 채우되 종횡비를 유지해 그린다 (letterbox).
  _drawFrame(g, img, Wc, Hc) {
    g.fillStyle = '#000'; g.fillRect(0, 0, Wc, Hc)
    const s = Math.min(Wc / img.width, Hc / img.height)
    const w = img.width * s, h = img.height * s
    g.drawImage(img, (Wc - w) / 2, (Hc - h) / 2, w, h)
  }

  // ---------- 로봇 상태 머신 ----------
  botStep() {
    // 실서버 위치가 들어오면 시뮬 주행을 멈추고 그 값을 따른다.
    if (this.externalPose) {
      this.bot.pos = { c: this.externalPose.c, r: this.externalPose.r }
      if (typeof this.externalPose.hd === 'number') this.bot.hd = this.externalPose.hd
      return
    }
    const bot = this.bot
    if (bot.mode === 'patrol') {
      const a = loop[bot.seg], b = loop[(bot.seg + 1) % loop.length]
      if (b.c !== a.c || b.r !== a.r) bot.hd = Math.atan2(b.r - a.r, b.c - a.c)
      bot.prog += speed.patrol; const p = Math.min(1, bot.prog)
      bot.pos = { c: a.c + (b.c - a.c) * p, r: a.r + (b.r - a.r) * p }
      if (p >= 1) { bot.prog = 0; bot.seg = (bot.seg + 1) % loop.length }
    } else if (bot.mode === 'goto' || bot.mode === 'dispatch') {
      if (bot.route.length < 2 || bot.rs >= bot.route.length - 1) return
      const a = bot.route[bot.rs], b = bot.route[bot.rs + 1]
      if (b.c !== a.c || b.r !== a.r) bot.hd = Math.atan2(b.r - a.r, b.c - a.c)
      bot.rp += speed.fast; const p = Math.min(1, bot.rp)
      bot.pos = { c: a.c + (b.c - a.c) * p, r: a.r + (b.r - a.r) * p }
      if (p >= 1) { bot.rp = 0; bot.rs++ }
    }
  }

  botGoto(cell, mode) {
    const bot = this.bot
    const cur = { c: Math.round(bot.pos.c), r: Math.round(bot.pos.r) }
    bot.route = astar(cur, cell)
    if (mode === 'dispatch' && bot.route.length > 1) bot.route = bot.route.slice(0, -1) // 사고 지점 앞 정지
    bot.rs = 0; bot.rp = 0; bot.mode = mode || 'goto'
  }

  botResume() {
    const bot = this.bot
    let bi = 0, bd = 1e9
    loop.forEach((p, i) => {
      const d = Math.abs(p.c - bot.pos.c) + Math.abs(p.r - bot.pos.r)
      if (d < bd) { bd = d; bi = i }
    })
    bot.seg = bi; bot.prog = 0; bot.mode = 'patrol'
    this.setMode('순찰 중', '')
  }

  setMode(txt, cls) {
    this.modeText = txt; this.modeClass = cls
    const m = this.bot.mode
    this.spd = (m === 'patrol' ? '0.6' : (m === 'manual' ? '0.0' : '1.2')) + ' m/s'
    this.rcamHud = 'MODE ' + (m === 'patrol' ? 'PATROL' : m === 'dispatch' ? 'EMERGENCY' : m === 'goto' ? 'GOTO' : 'MANUAL') + ' · MAP OK'
    this.emit()
  }

  // ---------- 로봇 지도 (SLAM 스타일) ----------
  drawMap() {
    const cv = this.canvases.map2d; if (!cv) return
    const g = fit(cv), Wc = cv.width, Hc = cv.height
    const t = this.t
    g.fillStyle = '#0a0c10'; g.fillRect(0, 0, Wc, Hc)
    const m = 14, cw = (Wc - m * 2) / CSn, ch = (Hc - m * 2) / RS
    const X = (c) => m + c * cw + cw / 2, Y = (r) => m + r * ch + ch / 2
    // SLAM 점묘 장애물
    g.fillStyle = '#59637a'
    for (let r = 0; r < RS; r++) for (let c = 0; c < CSn; c++) if (MAP[r][c] === 1) {
      for (let i = 0; i < 14; i++) {
        const rx = X(c) - cw / 2 + ((i * 37 + r * 13 + c * 7) % 100) / 100 * cw
        const ry = Y(r) - ch / 2 + ((i * 61 + c * 11) % 100) / 100 * ch
        g.fillRect(rx, ry, 1.6, 1.6)
      }
      g.strokeStyle = 'rgba(89,99,122,.35)'; g.strokeRect(X(c) - cw / 2 + 2, Y(r) - ch / 2 + 2, cw - 4, ch - 4)
    }
    // 외곽
    g.strokeStyle = '#3a4356'; g.lineWidth = 1.5; g.strokeRect(m - 4, m - 4, Wc - m * 2 + 8, Hc - m * 2 + 8)
    // 순찰 경로
    g.strokeStyle = 'rgba(63,143,224,.8)'; g.setLineDash([5, 4]); g.lineWidth = 1.4; g.beginPath()
    loop.forEach((p, i) => { i ? g.lineTo(X(p.c), Y(p.r)) : g.moveTo(X(p.c), Y(p.r)) })
    g.closePath(); g.stroke(); g.setLineDash([])
    // 긴급 경로
    if ((this.bot.mode === 'dispatch' || this.bot.mode === 'goto') && this.bot.route.length > 1) {
      g.strokeStyle = '#22b98a'; g.lineWidth = 2; g.beginPath()
      this.bot.route.forEach((p, i) => { i ? g.lineTo(X(p.c), Y(p.r)) : g.moveTo(X(p.c), Y(p.r)) })
      g.stroke()
    }
    // 분전반
    PANELS.forEach((p) => {
      const hot = this.heatOn && p.n === 'B'
      g.fillStyle = hot ? '#ff5648' : '#f5a623'
      g.fillRect(X(p.c) - 4, Y(p.r) - 4, 8, 8)
      g.fillStyle = hot ? '#ff8d85' : '#c9c2ae'; g.font = '9px Consolas,monospace'
      g.fillText(p.n + (hot ? ' 71°C!' : ''), X(p.c) + 6, Y(p.r) + 3)
    })
    // 화재
    if (this.fireOn) {
      const fx = X(FIREC.c), fy = Y(FIREC.r), pu = (Math.sin(t * .15) + 1) / 2
      g.strokeStyle = `rgba(255,86,72,${.4 + pu * .5})`; g.lineWidth = 2
      g.beginPath(); g.arc(fx, fy, 7 + pu * 5, 0, 7); g.stroke()
      g.fillStyle = '#ff5648'; g.beginPath(); g.arc(fx, fy, 3.5, 0, 7); g.fill()
    }
    // 로봇
    const rx = X(this.bot.pos.c), ry = Y(this.bot.pos.r)
    g.fillStyle = 'rgba(61,220,151,.18)'; g.beginPath(); g.arc(rx, ry, 10, 0, 7); g.fill()
    g.fillStyle = '#3ddc97'; g.beginPath(); g.arc(rx, ry, 4.5, 0, 7); g.fill()
  }

  // ---------- 로봇 전면 카메라 (현실적 산업용 카메라 피드) ----------
  drawRcam() {
    const cv = this.canvases.rcam; if (!cv) return
    const g = fit(cv), Wc = cv.width, Hc = cv.height, t = this.t

    // live: 로봇이 보내온 실제 전면 카메라 프레임 (YOLO 오버레이는 로봇 쪽에서 이미 합성됨)
    const front = this.externalFrames.FRONT
    if (front) {
      this._drawFrame(g, front.img, Wc, Hc)
      g.fillStyle = 'rgba(180,230,255,.75)'; g.font = '10px Consolas,monospace'
      g.fillText('FRONT · LIVE', 10, Hc - 12)
      return
    }
    const vx = Wc / 2, vy = Hc * 0.47, ex = Wc * 0.13 // 소실점 · 통로 폭
    const edgeX = (spread) => ex + (Wc / 2 - ex) * spread // 깊이별 통로 반폭

    // 배경(대기 원근)
    const sky = g.createLinearGradient(0, 0, 0, Hc)
    sky.addColorStop(0, '#0c1016'); sky.addColorStop(.46, '#12171e'); sky.addColorStop(.9, '#232a33'); sky.addColorStop(1, '#2b333d')
    g.fillStyle = sky; g.fillRect(0, 0, Wc, Hc)

    // 천장
    g.fillStyle = '#0f1319'
    g.beginPath(); g.moveTo(0, 0); g.lineTo(Wc, 0); g.lineTo(vx + ex, vy); g.lineTo(vx - ex, vy); g.closePath(); g.fill()

    // 좌/우 벽 + 케이블 트레이
    g.fillStyle = '#232a33'; g.beginPath(); g.moveTo(0, 0); g.lineTo(vx - ex, vy); g.lineTo(0, Hc); g.closePath(); g.fill()
    g.fillStyle = '#2b333d'; g.beginPath(); g.moveTo(Wc, 0); g.lineTo(vx + ex, vy); g.lineTo(Wc, Hc); g.closePath(); g.fill()
    g.strokeStyle = 'rgba(120,132,148,.35)'; g.lineWidth = 1
    g.beginPath(); g.moveTo(0, Hc * 0.16); g.lineTo(vx - ex, vy - Hc * 0.03); g.stroke()
    g.beginPath(); g.moveTo(Wc, Hc * 0.16); g.lineTo(vx + ex, vy - Hc * 0.03); g.stroke()

    // 바닥(콘크리트) — 클립 후 텍스처
    g.save()
    g.beginPath(); g.moveTo(0, Hc); g.lineTo(Wc, Hc); g.lineTo(vx + ex, vy); g.lineTo(vx - ex, vy); g.closePath(); g.clip()
    const floorG = g.createLinearGradient(0, vy, 0, Hc)
    floorG.addColorStop(0, '#1d232b'); floorG.addColorStop(1, '#343c47')
    g.fillStyle = floorG; g.fillRect(0, vy, Wc, Hc - vy)
    // 콘크리트 얼룩
    for (let i = 0; i < 46; i++) {
      const yy = vy + (Hc - vy) * (0.15 + this._hash(i, i * 3) * 0.85), spread = (yy - vy) / (Hc - vy)
      const xx = vx + (this._hash(i * 5, i) * 2 - 1) * edgeX(spread), r = (2 + this._hash(i, i * 2) * 5) * (0.4 + spread)
      g.fillStyle = `rgba(0,0,0,${0.04 + this._hash(i * 7, i) * 0.05})`; g.beginPath(); g.arc(xx, yy, r, 0, 7); g.fill()
    }
    // 신축 이음새(주행에 따라 흐름)
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1
    for (let i = 0; i < 7; i++) {
      const p = ((t * 0.004 + i / 7) % 1), yy = vy + (Hc - vy) * p * p, spread = (yy - vy) / (Hc - vy)
      g.beginPath(); g.moveTo(vx - edgeX(spread), yy); g.lineTo(vx + edgeX(spread), yy); g.stroke()
    }
    // 통로 안전선(노랑)
    g.strokeStyle = 'rgba(228,196,64,.18)'; g.lineWidth = Math.max(2, Wc * 0.006)
    g.beginPath(); g.moveTo(vx - Wc * 0.24, Hc); g.lineTo(vx - ex * 0.5, vy); g.stroke()
    g.beginPath(); g.moveTo(vx + Wc * 0.24, Hc); g.lineTo(vx + ex * 0.5, vy); g.stroke()
    g.restore()

    // 천장 형광등 + 바닥 광 풀(원근 흐름)
    for (let i = 0; i < 5; i++) {
      const p = ((t * 0.006 + i / 5) % 1), s = 0.14 + p * p * 1.5
      const ly = vy * (1 - p) * 0.98, lw = Math.max(6, Wc * 0.11 * s), lh = Math.max(2, Hc * 0.014 * s)
      g.fillStyle = `rgba(255,248,225,${0.45 + p * 0.4})`; g.fillRect(vx - lw / 2, ly, lw, lh)
      const gl = g.createRadialGradient(vx, ly, 1, vx, ly, lw * 1.5)
      gl.addColorStop(0, `rgba(255,246,210,${0.14 + p * 0.14})`); gl.addColorStop(1, 'rgba(255,246,210,0)')
      g.fillStyle = gl; g.beginPath(); g.arc(vx, ly, lw * 1.5, 0, 7); g.fill()
      if (p > 0.4) { // 바닥 광 풀
        const fyp = vy + (Hc - vy) * ((p - 0.4) / 0.6)
        const pool = g.createRadialGradient(vx, fyp, 2, vx, fyp, lw * 1.7)
        pool.addColorStop(0, `rgba(255,244,208,${0.07 * p})`); pool.addColorStop(1, 'rgba(255,244,208,0)')
        g.fillStyle = pool; g.beginPath(); g.ellipse(vx, fyp, lw * 1.7, lw * 0.55, 0, 0, 7); g.fill()
      }
    }

    // 원거리 대기 헤이즈
    const haze = g.createRadialGradient(vx, vy, 2, vx, vy, Math.max(Wc, Hc) * 0.5)
    haze.addColorStop(0, 'rgba(150,170,190,.20)'); haze.addColorStop(0.32, 'rgba(120,140,160,.06)'); haze.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = haze; g.fillRect(0, 0, Wc, Hc)

    // 우측 벽 분전반 (몸체+문+스트라이프+LED+배선 도관)
    const px = Wc * 0.72, py = Hc * 0.34, pw = Wc * 0.14, ph = Hc * 0.36, hot = this.heatOn
    if (hot) { const rg = g.createRadialGradient(px + pw / 2, py + ph * 0.55, 4, px + pw / 2, py + ph * 0.55, pw * 1.4); rg.addColorStop(0, 'rgba(255,80,55,.45)'); rg.addColorStop(1, 'rgba(255,80,55,0)'); g.fillStyle = rg; g.fillRect(px - pw * 0.7, py - ph * 0.2, pw * 2.4, ph * 1.5) }
    const pbG = g.createLinearGradient(px, 0, px + pw, 0); pbG.addColorStop(0, '#828b9a'); pbG.addColorStop(1, '#5e6672')
    g.fillStyle = pbG; g.fillRect(px, py, pw, ph)
    g.fillStyle = hot ? '#ef5648' : '#E0A93B'; g.fillRect(px, py, pw, 6)
    g.fillStyle = '#4f5763'; g.fillRect(px + pw * 0.13, py + ph * 0.15, pw * 0.74, ph * 0.68)
    g.strokeStyle = '#3a404a'; g.lineWidth = 1; g.strokeRect(px + pw * 0.13, py + ph * 0.15, pw * 0.74, ph * 0.68)
    g.fillStyle = '#2a2f37'; g.fillRect(px + pw * 0.76, py + ph * 0.42, pw * 0.06, ph * 0.16) // 손잡이
    g.fillStyle = hot ? '#ff5648' : '#37c08e'; g.beginPath(); g.arc(px + pw * 0.22, py + ph * 0.09, 3, 0, 7); g.fill()
    g.strokeStyle = '#2a2f37'; g.lineWidth = 2 // 배선 도관(천장으로)
    g.beginPath(); g.moveTo(px + pw * 0.5, py); g.lineTo(px + pw * 0.5, py - ph * 0.3); g.lineTo(px + pw * 0.9, py - ph * 0.5); g.stroke()
    g.fillStyle = '#9aa3b2'; g.font = '10px Consolas,monospace'; g.fillText('PANEL-B', px + 2, py - 6)

    // 화재 원거리(출동 중) + YOLO 박스
    if (this.fireOn && this.bot.mode === 'dispatch') {
      const p = Math.min(1, this.bot.rs / Math.max(1, this.bot.route.length - 1))
      const s = .5 + p * 1.7, fx = vx + Wc * .04 * s, fy = vy + Hc * .06 * s
      const glow = g.createRadialGradient(fx, fy, 2, fx, fy, 30 * s); glow.addColorStop(0, 'rgba(255,140,40,.4)'); glow.addColorStop(1, 'rgba(255,140,40,0)')
      g.fillStyle = glow; g.beginPath(); g.arc(fx, fy, 30 * s, 0, 7); g.fill()
      for (let i = 0; i < 5; i++) {
        const fl = Math.sin(t * .3 + i) * .5 + .5
        g.fillStyle = `rgba(235,${110 + i * 25},30,${.5 + fl * .4})`
        g.beginPath(); g.moveTo(fx - 8 * s + i * 4 * s, fy + 14 * s)
        g.quadraticCurveTo(fx - 3 * s + i * 4 * s, fy - 18 * s * (1 + fl * .5), fx + 2 * s + i * 4 * s, fy + 14 * s); g.fill()
      }
      g.strokeStyle = '#ff5648'; g.lineWidth = 2; g.strokeRect(fx - 15 * s, fy - 22 * s, 36 * s, 40 * s)
      g.fillStyle = '#ff5648'; g.fillRect(fx - 15 * s, fy - 34 * s, 78, 13)
      g.fillStyle = '#fff'; g.font = '700 10px Consolas,monospace'; g.fillText('fire ' + (0.55 + p * .35).toFixed(2), fx - 13 * s, fy - 25 * s)
    }

    // 렌즈 비네트
    const vig = g.createRadialGradient(vx, Hc * 0.5, Hc * 0.34, vx, Hc * 0.5, Hc * 0.85)
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.5)')
    g.fillStyle = vig; g.fillRect(0, 0, Wc, Hc)

    // 센서 노이즈 그레인
    for (let i = 0; i < Math.round(Wc * Hc / 900); i++) {
      const nx = this._hash(i, t % 211) * Wc, ny = this._hash(i * 1.7, (t + 40) % 197) * Hc
      g.fillStyle = `rgba(255,255,255,${this._hash(i, t % 53) * 0.04})`; g.fillRect(nx, ny, 1, 1)
    }

    // HUD 조준 리티클 + 코너 틱 + OSD
    g.strokeStyle = 'rgba(120,220,170,.55)'; g.lineWidth = 1
    g.beginPath(); g.moveTo(vx - 10, vy + Hc * 0.06); g.lineTo(vx - 3, vy + Hc * 0.06); g.moveTo(vx + 3, vy + Hc * 0.06); g.lineTo(vx + 10, vy + Hc * 0.06)
    g.moveTo(vx, vy + Hc * 0.06 - 10); g.lineTo(vx, vy + Hc * 0.06 - 3); g.moveTo(vx, vy + Hc * 0.06 + 3); g.lineTo(vx, vy + Hc * 0.06 + 10); g.stroke()
    g.strokeStyle = 'rgba(150,200,255,.5)'
    ;[[10, 10, 1, 1], [Wc - 10, 10, -1, 1], [10, Hc - 10, 1, -1], [Wc - 10, Hc - 10, -1, -1]].forEach(([x, y, dx, dy]) => {
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 14 * dx, y); g.moveTo(x, y); g.lineTo(x, y + 14 * dy); g.stroke()
    })
    g.fillStyle = 'rgba(180,230,255,.75)'; g.font = '10px Consolas,monospace'
    g.fillText('ORINCA-01 FRONT · 1920×1080 · 30FPS', 10, Hc - 12)
    // 얇은 스캔라인
    g.fillStyle = 'rgba(255,255,255,.025)'
    for (let y = t % 3; y < Hc; y += 3) g.fillRect(0, y, Wc, 1)
  }

  // ---------- 열화상 카메라 (현실적 온보드 FLIR · 저해상도 열 센서) ----------
  // 실제 열화상처럼 전 화면을 저해상도 블록 온도장으로 렌더(천장 냉 · 바닥 온 · 설비 열원)하고,
  // 그 위에 FLIR 측정 오버레이(스팟·박스·min/max·팔레트)를 얹는다.
  drawThermal() {
    const cv = this.canvases.tcam; if (!cv) return
    const g = fit(cv), Wc = cv.width, Hc = cv.height, t = this.t
    const bx = this.bot.pos.c, br = this.bot.pos.r
    const vx = Wc / 2, vy = Hc * 0.47

    // live: 로봇 열화상 프레임. HUD 최고온도는 프레임에 실려온 maxTemp를 그대로 쓴다.
    const thermal = this.externalFrames.THERMAL
    if (thermal) {
      this._drawFrame(g, thermal.img, Wc, Hc)
      if (typeof thermal.maxTemp === 'number') {
        this.thermalMax = 'MAX ' + thermal.maxTemp.toFixed(1) + '°C' + (thermal.maxTemp > 60 ? ' ⚠ 임계 초과' : '')
        this.thermalColor = thermal.maxTemp > 60 ? '#ff8d85' : (thermal.maxTemp > 52 ? '#ffd9a8' : '#b9ffe0')
      }
      g.fillStyle = 'rgba(255,220,180,.9)'; g.font = '11px Consolas,monospace'
      g.fillText('THERMAL · LIVE', 10, 18)
      return
    }

    // 아이언바우 팔레트
    const stops = [[6, 10, 52], [24, 36, 150], [128, 28, 150], [214, 48, 58], [248, 142, 22], [255, 236, 120], [255, 255, 255]]
    const pos = [0, 0.2, 0.4, 0.6, 0.8, 0.92, 1]
    const heat = (v) => {
      v = v < 0 ? 0 : v > 1 ? 1 : v
      let i = 0; while (i < pos.length - 1 && v > pos[i + 1]) i++
      const k = (v - pos[i]) / ((pos[i + 1] - pos[i]) || 1), a = stops[i], b = stops[i + 1]
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`
    }

    // 겨냥 분전반 + 표면온도 easing
    let near
    if (this.heatOn) near = PANELS.find((p) => p.n === 'B')
    else { near = PANELS[0]; let nd = 1e9; for (const p of PANELS) { const d = Math.hypot(p.c - bx, p.r - br); if (d < nd) { nd = d; near = p } } }
    const dist = Math.hypot(near.c - bx, near.r - br)
    const prox = Math.max(0, 1 - dist / 6)
    const panelBase = near.n === 'A' ? 39 : near.n === 'B' ? 43 : 41
    const panelTarget = (this.heatOn && near.n === 'B') ? 71.3 : panelBase
    const floorMin = (this.heatOn && near.n === 'B') ? 0.5 : 0
    const target = 34 + (panelTarget - 34) * Math.max(prox, floorMin)
    this.heatT += (target - this.heatT) * 0.05
    const hv = Math.max(0, Math.min(1, (this.heatT - 30) / 44))

    // 열원 좌표: 분전반 / 화재 / 배관 잔열
    const pcx = Wc * (0.64 + Math.max(-0.08, Math.min(0.08, (near.c - bx) * 0.02))) + Wc * 0.085
    const pcy = Hc * 0.51, prx = Wc * 0.11, pry = Hc * 0.24
    const fireHot = this.fireOn && this.bot.mode === 'dispatch'
    let fx = 0, fy = 0, fr = 1, fp = 0
    if (fireHot) { fp = Math.min(1, this.bot.rs / Math.max(1, this.bot.route.length - 1)); const s = .6 + fp * 1.6; fx = vx + Wc * .04 * s; fy = vy + Hc * .08 * s; fr = 26 * s }
    const travel = bx * 0.9 + br * 0.6
    const pipes = [0, 1, 2].map((i) => { const frac = ((i * 0.33 + travel * 0.04) % 1 + 1) % 1; return { x: Wc * frac, y: Hc * (0.62 + Math.sin(i * 2 + br * 0.4) * 0.08), r: Wc * 0.07 } })

    // 저해상도 블록 온도장 (실제 열 센서 픽셀감)
    const bs = Math.max(7, Math.round(Wc / 54))
    for (let yy = 0; yy < Hc; yy += bs) {
      for (let xx = 0; xx < Wc; xx += bs) {
        const cxp = xx + bs / 2, cyp = yy + bs / 2
        let v
        if (cyp < vy) v = 0.04 + (cyp / vy) * 0.06                    // 천장/원거리 냉
        else { const fv = (cyp - vy) / (Hc - vy); v = 0.10 + fv * 0.22 } // 바닥 온
        v += (Math.abs(cxp - vx) / (Wc / 2)) * 0.05                    // 벽 가장자리 잔열
        for (const pp of pipes) { const dx = (cxp - pp.x) / pp.r, dy = (cyp - pp.y) / pp.r; v += 0.30 * Math.exp(-(dx * dx + dy * dy)) }
        { const dx = (cxp - pcx) / prx, dy = (cyp - pcy) / pry; v += (0.2 + hv * 0.75) * Math.exp(-(dx * dx + dy * dy)) } // 분전반 열원
        if (fireHot) { const dx = (cxp - fx) / fr, dy = (cyp - fy) / fr; v += 0.95 * Math.exp(-(dx * dx + dy * dy)) }
        v += (this._hash(xx * 0.7 + yy * 1.3, t % 64) - 0.5) * 0.05    // 열 센서 노이즈
        g.fillStyle = heat(v)
        g.fillRect(xx, yy, bs + 1, bs + 1)
      }
    }

    // 측정 박스(분전반 표면온도)
    g.strokeStyle = '#fff'; g.lineWidth = 1.3; g.strokeRect(pcx - 26, pcy - 18, 52, 36)
    g.beginPath(); g.moveTo(pcx - 5, pcy); g.lineTo(pcx + 5, pcy); g.moveTo(pcx, pcy - 5); g.lineTo(pcx, pcy + 5); g.stroke()
    g.fillStyle = '#fff'; g.font = '700 12px Consolas,monospace'; g.textAlign = 'center'
    g.fillText(this.heatT.toFixed(1) + '°C', pcx, pcy - 22)
    g.font = '10px Consolas,monospace'; g.fillText('분전반 ' + near.n, pcx, pcy + 30)
    g.textAlign = 'left'

    // 화재 박스
    if (fireHot) {
      g.strokeStyle = '#fff'; g.lineWidth = 1.4; g.strokeRect(fx - 14, fy - 16, 30, 34)
      g.fillStyle = '#fff'; g.font = '700 10px Consolas,monospace'; g.fillText('HOT ' + (120 + fp * 80).toFixed(0) + '°C', fx - 14, fy - 20)
    }

    // 중앙 스팟 + min/max 마커
    const sy = vy + Hc * 0.2
    g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1
    g.beginPath(); g.moveTo(vx - 8, sy); g.lineTo(vx + 8, sy); g.moveTo(vx, sy - 8); g.lineTo(vx, sy + 8); g.stroke()
    g.fillStyle = '#fff'; g.font = '10px Consolas,monospace'; g.fillText((25 + prox * 3).toFixed(1) + '°C', vx + 11, sy + 3)
    g.fillStyle = '#ff4b3a'; g.beginPath(); g.arc(pcx, pcy, 3, 0, 7); g.fill()          // MAX
    g.fillStyle = '#4fd0ff'; g.beginPath(); g.arc(Wc * 0.12, Hc * 0.14, 3, 0, 7); g.fill() // MIN
    g.fillStyle = 'rgba(120,200,255,.9)'; g.fillText('19.4°C', Wc * 0.12 + 6, Hc * 0.14 + 3)

    // 팔레트 스케일 바(우측)
    const barX = Wc - 16, barY = Hc * 0.16, barH = Hc * 0.62
    const pbar = g.createLinearGradient(0, barY, 0, barY + barH)
    pbar.addColorStop(0, heat(1)); pbar.addColorStop(0.5, heat(0.55)); pbar.addColorStop(1, heat(0.05))
    g.fillStyle = pbar; g.fillRect(barX, barY, 9, barH)
    g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 1; g.strokeRect(barX, barY, 9, barH)
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '9px Consolas,monospace'; g.textAlign = 'right'
    g.fillText('75°', barX - 3, barY + 8); g.fillText('45°', barX - 3, barY + barH / 2 + 3); g.fillText('20°', barX - 3, barY + barH)
    g.textAlign = 'left'

    // HUD 라벨 갱신 + 코너 라벨
    this.thermalMax = 'MAX ' + this.heatT.toFixed(1) + '°C' + (this.heatT > 60 ? ' ⚠ 임계 초과' : '')
    this.thermalColor = this.heatT > 60 ? '#ff8d85' : (this.heatT > 52 ? '#ffd9a8' : '#b9ffe0')
    g.fillStyle = 'rgba(255,220,180,.9)'; g.font = '11px Consolas,monospace'
    g.fillText('THERMAL · FLIR · 640×480 · ε0.95', 10, 18)
  }

  // ---------- 이벤트 데모 ----------
  setFire(on) {
    this.fireOn = on
    this.det.flameState = on ? '발생' : '미발생'
    this.det.flamePct = on ? '62.5%' : '0%'
    this.det.smokeState = on ? '발생' : '미발생'
    this.det.smokePct = on ? '31.2%' : '0%'
    const h = new Date().getHours() * 2 + (new Date().getMinutes() >= 30 ? 1 : 0)
    if (on) {
      this.conf.fill(0); this.conf[h] = 62.5
      this.pushLog('fire', 'CAM3 화재 탐지 (불꽃 62.5%) — 오린카 긴급 출동 지시')
      this.botGoto(FIREC, 'dispatch'); this.setMode('긴급 출동', 'emg')
    } else {
      this.pushLog('ok', '화재 조치 완료 — 오린카 순찰 복귀')
      this.botResume()
    }
    this.emit()
  }

  setHeat(on) {
    this.heatOn = on
    if (on) this.pushLog('heat', '분전반 B 표면온도 임계 초과 (71.3°C > 60°C) — 과열 자동 경보')
    else this.pushLog('ok', '분전반 B 온도 정상 복귀 — 경보 해제')
    this.emit()
  }

  toggleFire() { this.setFire(!this.fireOn) }
  toggleHeat() { this.setHeat(!this.heatOn) }
  toggleSound() { this.soundOn = !this.soundOn; this.emit() }

  // ---------- CCTV 조작 ----------
  ptzMove(dir) {
    if (dir === 'u') this.ptz.y -= 1
    if (dir === 'd') this.ptz.y += 1
    if (dir === 'l') this.ptz.x -= 1
    if (dir === 'r') this.ptz.x += 1
    if (dir === 'c') { this.ptz.x = 0; this.ptz.y = 0; this.ptz.z = 1 }
    // 팬/틸트 범위 제한 (-5 ~ 5)
    this.ptz.x = Math.max(-5, Math.min(5, this.ptz.x))
    this.ptz.y = Math.max(-5, Math.min(5, this.ptz.y))
    this.emit()
  }

  ptzZoom(delta) {
    this.ptz.z = Math.min(2.4, Math.max(1, this.ptz.z + 0.2 * delta))
    this.emit()
  }

  // ---------- 로봇 조작 ----------
  segSet(man) {
    this.seg = man ? 'manual' : 'patrol'
    if (man) { this.bot.mode = 'manual'; this.setMode('수동 조작', 'man') }
    else this.botResume()
  }

  // dir: 'w'|'a'|'s'|'d'  (전진/좌/후진/우) — 원본 data-m 매핑과 동일
  dpadMove(dir) {
    if (this.bot.mode !== 'manual') this.segSet(true)
    const map = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] }
    const [dc, dr] = map[dir] || [0, 0]
    const nc = Math.round(this.bot.pos.c) + dc, nr = Math.round(this.bot.pos.r) + dr
    if (nc >= 0 && nr >= 0 && nc < CSn && nr < RS && MAP[nr][nc] === 0) this.bot.pos = { c: nc, r: nr }
  }

  dpStop() { this.segSet(true) }
  emergencyStop() { this.bot.mode = 'manual'; this.setMode('긴급 정지', 'emg'); this.pushLog('heat', '수동 긴급 정지 (E-STOP)') }
  reset() { this.segSet(true); this.pushLog('ok', '제어 리셋') }
  returnPatrol() { this.botResume(); this.pushLog('ok', '순찰 복귀 명령') }

  goto(value, label) {
    const [c, r] = value.split(',').map(Number)
    this.botGoto({ c, r }, 'goto'); this.setMode('지점 이동', 'man')
    this.pushLog('ok', '지점 이동: ' + label)
  }

  toggleSwitch(name) {
    this.switches[name] = !this.switches[name]
    this.emit()
  }

  // ---------- 메인 루프 ----------
  tick() {
    this.t++
    this.botStep()
    // 환경값 미세 변동
    if (this.t % 40 === 0) {
      this.envT = (24.6 + Math.sin(this.t * .001) * 0.4).toFixed(1) + '°C'
      this.envH = Math.round(41 + Math.sin(this.t * .0013) * 2) + '%'
      this.bt++
      if (this.bt % 20 === 0 && this.batt > 20) { this.batt-- }
    }
    if (this.currentTab === 'cctv') {
      if (this.canvases.cam3) this.drawFactoryCam(this.canvases.cam3, this.ptz)
      this.drawConf()
    } else {
      this.drawRcam(); this.drawThermal(); this.drawMap()
    }
    this._raf = requestAnimationFrame(this.tick)
  }
}
