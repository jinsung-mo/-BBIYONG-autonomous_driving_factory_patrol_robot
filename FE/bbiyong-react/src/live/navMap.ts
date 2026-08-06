// 실시간 2D SLAM 맵 렌더러 — docs/439_live_nav_map_fe_porting.md 기준.
//
// 로봇팀 대시보드(BE_robot/orin_dashboard/static/nav.html)의 렌더 로직을 그대로 옮겼다.
// 로봇은 HTTP 폴링으로, 관제는 STOMP 구독으로 받는 차이뿐이라 디코드·렌더는 동일하다.
//
// 좌표는 payload 의 ox/oy/res 를 직접 쓴다. pose·scan·맵 원점이 모두 미터·map 프레임으로
// 일관돼 있어 config.js 의 임시 스케일 매핑(MAP_ORIGIN/METERS_PER_CELL)은 이 패널에 쓰지 않는다.

// 궤적 상한 — 3Hz 로 들어오므로 무제한이면 장시간 운용 시 계속 쌓인다(약 30분 분량)
export const TRAIL_MAX = 5000

// 점유값 → 표시 문자. <0 미탐색 · >50 벽 · 그 외 자유
function mapSymbol(value: any) { return value < 0 ? '.' : value > 50 ? '#' : ' ' }

// flat RLE([값, 개수, 값, 개수, ...]) → row-major(아래→위) 문자열
export function decodeMapSnapshot(msg: any) {
  const cells = []
  for (let i = 0; i < msg.cells.length; i += 2) {
    cells.push(mapSymbol(msg.cells[i]).repeat(msg.cells[i + 1]))
  }
  const data = cells.join('')
  if (data.length !== msg.w * msg.h) throw new Error(`맵 크기 불일치: ${data.length} != ${msg.w * msg.h}`)
  return { w: msg.w, h: msg.h, res: msg.res, ox: msg.ox, oy: msg.oy, seq: msg.sequence, data }
}

// 셀이 많아 매 프레임 다시 그리면 느리다 — sequence 가 바뀔 때만 1픽셀=1셀로 굽고 draw 에서 확대한다
export function bakeMap(m: any) {
  const c = document.createElement('canvas')
  c.width = m.w; c.height = m.h
  const g = c.getContext('2d')!
  const img = g.createImageData(m.w, m.h)
  const d = img.data, s = m.data
  for (let i = 0; i < m.w * m.h; i++) {
    const ch = s.charCodeAt(i)
    let v, a = 255
    if (ch === 35) v = 20            // '#' 벽
    else if (ch === 32) v = 245      // ' ' 자유
    else { v = 60; a = 90 }          // '.' 미탐색
    // 맵은 아래→위 순서라 이미지 y 를 뒤집는다
    const row = m.h - 1 - ((i / m.w) | 0)
    const col = i % m.w
    const j = (row * m.w + col) * 4
    d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = a
  }
  g.putImageData(img, 0, 0)
  return c
}

// view.s = 픽셀/미터, view.x/y = 팬 오프셋
export function makeView() { return { x: 0, y: 0, s: 60, init: false } }

// 맵을 캔버스에 맞춘다 (첫 MAP 수신 시 · 캔버스 크기가 바뀌었을 때)
export function fitView(view: any, cv: any, m: any) {
  if (!cv.width || !cv.height) return false
  const w = m.w * m.res, h = m.h * m.res
  view.s = Math.min(cv.width / w, cv.height / h) * 0.88
  view.x = cv.width / 2 - (m.ox + w / 2) * view.s
  view.y = cv.height / 2 + (m.oy + h / 2) * view.s
  view.init = true
  return true
}

// 캔버스를 부모 크기에 맞추고 2D 컨텍스트를 반환 (Simulation 의 fit 과 같은 역할)
export function fitCanvas(cv: any) {
  const r = cv.parentElement?.getBoundingClientRect()
  if (!r) return null
  const w = Math.round(r.width), h = Math.round(r.height)
  if (!w || !h) return null
  const resized = cv.width !== w || cv.height !== h
  if (resized) { cv.width = w; cv.height = h }
  return { g: cv.getContext('2d'), resized }
}

// 지도 배경을 하나로 정한다 (S15P11E101-524).
// 정제 도면이 있으면 그것을, 없으면 원본 점유격자를 쓴다. 둘 다 원점(m)과 m/px 로
// 배치가 정해지므로 그리기·화면 맞춤이 같은 식을 쓸 수 있다.
// 이미지 행 0 이 위(+y 끝)라 좌상단은 (ox, oy + h*res) 다 — 두 경우 모두 동일하다.
export function backgroundOf(nav: any, showPlan = true) {
  const ok = (o: any) => !!o?.img && [o.w, o.h, o.res, o.ox, o.oy].every(Number.isFinite)
  const plan = showPlan ? nav?.plan : null
  if (ok(plan)) return { ...plan, isPlan: true }
  const raw = nav?.mapCanvas ? { ...nav.map, img: nav.mapCanvas } : null
  return ok(raw) ? { ...raw, isPlan: false } : null
}

// 화면 픽셀 → map 프레임 미터 (S15P11E101-514).
// drawNav 의 sx/sy 를 그대로 뒤집는다. heading-up 일 때는 캔버스가 로봇 화면 위치를 축으로
// (yaw - 90°) 만큼 돌아가 있으므로, 클릭 지점을 같은 축에서 반대로 돌린 뒤 환산한다.
export function canvasToWorld(view: any, nav: any, headingUp: any, px: any, py: any, cv: any = null) {
  let x = px, y = py
  // 표시 회전을 먼저 되돌린다(S15P11E101-746). 화면에서 찍은 자리를 그리기 전 좌표로
  // 옮겨야 한다 — 안 그러면 조작자가 찍은 곳과 로봇이 가는 곳이 정반대가 된다.
  if (cv) {
    const mx = cv.width / 2, my = cv.height / 2
    const a = -DISPLAY_ROT
    const dx = x - mx, dy = y - my
    x = mx + dx * Math.cos(a) - dy * Math.sin(a)
    y = my + dx * Math.sin(a) + dy * Math.cos(a)
  }
  if (headingUp && nav?.pose) {
    const cx = view.x + nav.pose.x * view.s
    const cy = view.y - nav.pose.y * view.s
    const a = -(nav.pose.yaw - Math.PI / 2)
    const dx = px - cx, dy = py - cy
    x = cx + dx * Math.cos(a) - dy * Math.sin(a)
    y = cy + dx * Math.sin(a) + dy * Math.cos(a)
  }
  return { x: (x - view.x) / view.s, y: (view.y - y) / view.s }
}

// 맵 경계 안쪽인지. 맵 밖을 찍으면 로봇이 갈 수 없는 좌표가 저장된다.
//
// 기준은 '지금 화면에 그려진 배경'이다(S15P11E101-629). 예전에는 SLAM 점유격자만 봤는데,
// 도면만 있고 실시간 맵이 없는 상태에서는 어디를 찍어도 거부됐다 — 보이는 것과 판정하는 것이
// 달랐다. originYaw 가 있으면 원점 기준으로 되돌린 뒤 재어야 한다.
export function insideMap(m: any, x: any, y: any) {
  if (!m || ![m.w, m.h, m.res, m.ox, m.oy].every(Number.isFinite)) return false
  let dx = x - m.ox
  let dy = y - m.oy
  const yaw = Number(m.oyaw) || 0
  if (yaw) {
    const c = Math.cos(-yaw), s2 = Math.sin(-yaw)
    const rx = dx * c - dy * s2
    const ry = dx * s2 + dy * c
    dx = rx; dy = ry
  }
  return dx >= 0 && dy >= 0 && dx <= m.w * m.res && dy <= m.h * m.res
}

// 맵 + 궤적 + 스캔 + 로봇 — nav.html 그대로
//
/**
 * 지도 표시 회전(S15P11E101-746). 순수하게 보여 주는 각도이고 데이터는 건드리지 않는다.
 * SLAM·도면·로봇이 이 하나를 같이 써야 서로 어긋나지 않는다.
 */
export const DISPLAY_ROT = Math.PI

/**
 * 라이다가 로봇 앞을 보지 않고 돌아 붙어 있는 만큼(S15P11E101-763).
 * TF 실측이 약 -175.7도였다 — 앞뒤가 거의 뒤집힌 셈이라, 이 값을 빼먹으면
 * 스캔이 벽 반대편에 찍혀 지도와 어긋난다.
 *
 * 원래는 로봇이 TF 로 알려 줄 값이고 FE 가 알 일이 아니다. 지금은 그 경로가 없어
 * 여기에 둔다 — 장비를 다시 달면 이 상수 하나만 고치면 된다.
 */
export const LASER_YAW_OFFSET = Number(
  (import.meta as any).env?.VITE_LASER_YAW_OFFSET ?? -3.066,
)

// headingUp: 로봇 진행 방향이 항상 위를 향하도록 화면을 돌린다(주행 시 방향 감각 유지).
// 끄면 북향(+y 위) 고정 — ROS map 프레임 그대로다.
// route: 순찰 경로(S15P11E101-514). [{x, y, name}] 순서대로 선으로 잇고 번호를 붙인다.
// showPlan: 정제 도면(S15P11E101-524)을 원본 점유격자 대신 배경으로 쓴다.
/**
 * overlays=false 면 도면만 그린다(S15P11E101-749).
 * 평면 뷰는 '완성된 도면' 을 보는 화면이다. 그 위에 실시간 스캔점과 궤적을 얹으면
 * 확정된 벽과 지금 재고 있는 점이 한 그림으로 읽혀, 어디까지가 사실인지 알 수 없다.
 * 실시간 레이어는 3D 압출 뷰와 운영 탭이 맡는다.
 */
export function drawNav(g: any, cv: any, nav: any, view: any, headingUp = false, route: any = null, showPlan = true, overlays = true) {
  g.fillStyle = '#15171c'
  g.fillRect(0, 0, cv.width, cv.height)
  if (!nav) return

  // 표시 회전(S15P11E101-746). 화면에 나오는 지도가 실제와 180도 뒤집혀 있었다.
  // 데이터(격자·origin·resolution·pose)는 방향 중립이고 BE 는 원문을 그대로 중계하므로,
  // 돌리는 자리는 여기 렌더뿐이다.
  //
  // 캔버스 변환으로 건다 — 배경·스캔·로봇·경로가 모두 이 변환 아래에서 그려지므로
  // 함께 돈다. 지도만 돌리면 로봇이 어긋난다.
  g.save()
  g.translate(cv.width / 2, cv.height / 2)
  g.rotate(DISPLAY_ROT)
  g.translate(-cv.width / 2, -cv.height / 2)

  const sx = (mx: any) => view.x + mx * view.s
  const sy = (my: any) => view.y - my * view.s   // 화면 y 는 아래로 증가 → 부호 반전

  // heading-up: 로봇 화면 위치를 축으로 (yaw - 90°) 만큼 돌리면 진행 방향이 위가 된다.
  // 회전은 캔버스 변환으로만 걸고 좌표 계산(sx/sy)은 건드리지 않는다.
  const rotating = headingUp && nav.pose
  if (rotating) {
    const px = sx(nav.pose.x), py = sy(nav.pose.y)
    g.save()
    g.translate(px, py)
    g.rotate(nav.pose.yaw - Math.PI / 2)
    g.translate(-px, -py)
  }

  const bg = backgroundOf(nav, showPlan)
  if (bg) {
    // 도면은 이미 정제된 그림이라 확대 시 부드럽게, 점유격자는 셀 경계를 살려 또렷하게
    g.imageSmoothingEnabled = bg.isPlan
    // ROS map 규약: origin 은 이미지 좌하단의 map 프레임 포즈이고, originYaw 만큼 돌아 있다.
    // 이걸 무시하면 회전된 맵이 축에 나란히 그려져, 조작자가 보고 찍은 자리가 실제
    // 월드 좌표와 어긋난다(S15P11E101-629). 좌하단을 축으로 돌려서 그린다.
    const yaw = Number(bg.oyaw) || 0
    const wpx = bg.w * bg.res * view.s
    const hpx = bg.h * bg.res * view.s
    if (yaw) {
      const ax = sx(bg.ox), ay = sy(bg.oy)      // 좌하단 = 회전축
      g.save()
      g.translate(ax, ay)
      g.rotate(-yaw)                            // 화면 y 는 아래로 자라므로 부호를 뒤집는다
      g.drawImage(bg.img, 0, -hpx, wpx, hpx)
      g.restore()
    } else {
      g.drawImage(bg.img, sx(bg.ox), sy(bg.oy + bg.h * bg.res), wpx, hpx)
    }
  }

  // 도면만 보는 화면이면 여기서 끝낸다. 나침반은 아래에서 화면 좌표계에 따로 그린다.
  if (!overlays) {
    g.restore()
    drawCompass(g, cv, DISPLAY_ROT)
    return
  }

  const p = nav.pose
  const trail = nav.trail

  if (trail && trail.length > 1) {
    g.strokeStyle = 'rgba(240,201,138,0.55)'; g.lineWidth = 2
    g.beginPath(); g.moveTo(sx(trail[0][0]), sy(trail[0][1]))
    for (const t of trail) g.lineTo(sx(t[0]), sy(t[1]))
    g.stroke()
  }

  // LiDAR 스캔 — ranges[i] === 0 은 무효 측정이라 건너뛴다
  // scan 은 {ranges, angle_min, angle_inc} 객체다. 모양이 다르면 그리지 않고 넘어간다 —
  // 3Hz 로 들어오는 값이라 여기서 던지면 콘솔이 초당 3건씩 쌓인다.
  if (p && nav.scan?.ranges?.length) {
    const s = nav.scan
    g.fillStyle = 'rgba(122,162,210,0.85)'
    for (let i = 0; i < s.ranges.length; i++) {
      const r = s.ranges[i]
      if (!r) continue
      const a = p.yaw + LASER_YAW_OFFSET + s.angle_min + i * s.angle_inc
      g.fillRect(sx(p.x + r * Math.cos(a)) - 1, sy(p.y + r * Math.sin(a)) - 1, 2, 2)
    }
  }

  // 순찰 경로 — 지나갈 순서를 선으로 잇고 각 지점에 번호를 붙인다.
  // 로봇 마커보다 먼저 그려 로봇이 지점 위에 있어도 가려지지 않게 한다.
  if (route && route.length) {
    if (route.length > 1) {
      g.strokeStyle = 'rgba(61,220,151,0.55)'; g.lineWidth = 2; g.setLineDash([6, 4])
      g.beginPath(); g.moveTo(sx(route[0].x), sy(route[0].y))
      for (const w of route) g.lineTo(sx(w.x), sy(w.y))
      g.stroke(); g.setLineDash([])
    }
    route.forEach((w: any, i: any) => {
      const X = sx(w.x), Y = sy(w.y)
      g.fillStyle = '#3ddc97'
      g.beginPath(); g.arc(X, Y, 9, 0, Math.PI * 2); g.fill()
      g.fillStyle = '#0b0d11'
      g.font = 'bold 11px system-ui, sans-serif'
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(String(i + 1), X, Y + 0.5)
    })
    g.textAlign = 'start'; g.textBaseline = 'alphabetic'
  }

  // 로봇 마커 (점 + 방향 화살표) — pose 는 TF 미확보 시 없을 수 있다
  if (p) {
    const X = sx(p.x), Y = sy(p.y), R = Math.max(5, view.s * 0.10)
    g.fillStyle = '#f0c98a'
    g.beginPath(); g.arc(X, Y, R, 0, Math.PI * 2); g.fill()
    g.strokeStyle = '#f0c98a'; g.lineWidth = 2.5
    g.beginPath(); g.moveTo(X, Y)
    g.lineTo(X + Math.cos(p.yaw) * R * 2.4, Y - Math.sin(p.yaw) * R * 2.4)
    g.stroke()
  }

  if (rotating) g.restore()

  // 표시 회전을 여기서 푼다. 나침반은 화면 좌표계에 그려야 하기 때문이다.
  g.restore()
  // 방위 표시 — 회전 여부와 무관하게 북쪽이 어디인지 항상 알 수 있게 화면 좌표계에 그린다.
  // 표시 회전도 화면이 돌아간 각도이므로 함께 더한다 — 안 더하면 N 이 반대를 가리킨다.
  drawCompass(g, cv, (rotating ? nav.pose.yaw - Math.PI / 2 : 0) + DISPLAY_ROT)
}

// 우상단 나침반. angle 만큼 돌아간 화면에서 북(+y)이 향하는 방향을 가리킨다.
function drawCompass(g: any, cv: any, angle: any) {
  const cx = cv.width - 26, cy = 26, r = 13
  g.save()
  g.fillStyle = 'rgba(6,9,14,.62)'
  g.beginPath(); g.arc(cx, cy, r + 3, 0, Math.PI * 2); g.fill()
  g.translate(cx, cy)
  g.rotate(-angle)
  g.strokeStyle = '#cfd6e4'; g.lineWidth = 2
  g.beginPath(); g.moveTo(0, r); g.lineTo(0, -r); g.stroke()
  g.fillStyle = '#ff7d74'
  g.beginPath(); g.moveTo(0, -r); g.lineTo(-4, -r + 7); g.lineTo(4, -r + 7); g.closePath(); g.fill()
  g.restore()
  g.fillStyle = '#cfd6e4'
  g.font = 'bold 9px Consolas, monospace'
  g.textAlign = 'center'
  g.fillText('N', cx, cy + r + 12)
  g.textAlign = 'start'
}
