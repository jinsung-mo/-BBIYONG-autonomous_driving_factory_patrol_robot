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
function mapSymbol(value) { return value < 0 ? '.' : value > 50 ? '#' : ' ' }

// flat RLE([값, 개수, 값, 개수, ...]) → row-major(아래→위) 문자열
export function decodeMapSnapshot(msg) {
  const cells = []
  for (let i = 0; i < msg.cells.length; i += 2) {
    cells.push(mapSymbol(msg.cells[i]).repeat(msg.cells[i + 1]))
  }
  const data = cells.join('')
  if (data.length !== msg.w * msg.h) throw new Error(`맵 크기 불일치: ${data.length} != ${msg.w * msg.h}`)
  return { w: msg.w, h: msg.h, res: msg.res, ox: msg.ox, oy: msg.oy, seq: msg.sequence, data }
}

// 셀이 많아 매 프레임 다시 그리면 느리다 — sequence 가 바뀔 때만 1픽셀=1셀로 굽고 draw 에서 확대한다
export function bakeMap(m) {
  const c = document.createElement('canvas')
  c.width = m.w; c.height = m.h
  const g = c.getContext('2d')
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
export function fitView(view, cv, m) {
  if (!cv.width || !cv.height) return false
  const w = m.w * m.res, h = m.h * m.res
  view.s = Math.min(cv.width / w, cv.height / h) * 0.88
  view.x = cv.width / 2 - (m.ox + w / 2) * view.s
  view.y = cv.height / 2 + (m.oy + h / 2) * view.s
  view.init = true
  return true
}

// 캔버스를 부모 크기에 맞추고 2D 컨텍스트를 반환 (Simulation 의 fit 과 같은 역할)
export function fitCanvas(cv) {
  const r = cv.parentElement?.getBoundingClientRect()
  if (!r) return null
  const w = Math.round(r.width), h = Math.round(r.height)
  if (!w || !h) return null
  const resized = cv.width !== w || cv.height !== h
  if (resized) { cv.width = w; cv.height = h }
  return { g: cv.getContext('2d'), resized }
}

// 맵 + 궤적 + 스캔 + 로봇 — nav.html 그대로
//
// headingUp: 로봇 진행 방향이 항상 위를 향하도록 화면을 돌린다(주행 시 방향 감각 유지).
// 끄면 북향(+y 위) 고정 — ROS map 프레임 그대로다.
export function drawNav(g, cv, nav, view, headingUp = false) {
  g.fillStyle = '#15171c'
  g.fillRect(0, 0, cv.width, cv.height)
  if (!nav) return

  const sx = (mx) => view.x + mx * view.s
  const sy = (my) => view.y - my * view.s   // 화면 y 는 아래로 증가 → 부호 반전

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

  const m = nav.map
  if (m && nav.mapCanvas) {
    g.imageSmoothingEnabled = false
    g.drawImage(nav.mapCanvas, sx(m.ox), sy(m.oy + m.h * m.res),
      m.w * m.res * view.s, m.h * m.res * view.s)
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
  if (p && nav.scan) {
    const s = nav.scan
    g.fillStyle = 'rgba(122,162,210,0.85)'
    for (let i = 0; i < s.ranges.length; i++) {
      const r = s.ranges[i]
      if (!r) continue
      const a = p.yaw + s.angle_min + i * s.angle_inc
      g.fillRect(sx(p.x + r * Math.cos(a)) - 1, sy(p.y + r * Math.sin(a)) - 1, 2, 2)
    }
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

  // 방위 표시 — 회전 여부와 무관하게 북쪽이 어디인지 항상 알 수 있게 화면 좌표계에 그린다
  drawCompass(g, cv, rotating ? nav.pose.yaw - Math.PI / 2 : 0)
}

// 우상단 나침반. angle 만큼 돌아간 화면에서 북(+y)이 향하는 방향을 가리킨다.
function drawCompass(g, cv, angle) {
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
