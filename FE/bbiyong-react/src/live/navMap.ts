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

// MAP 패킷에서 순찰 마스크 블록을 꺼낸다(S15P11E101-869).
//
// 🔴 필드 이름은 MAP 패킷 원문 그대로 snake_case `patrol_mask` 다. 서버는 MAP 을 DTO 로
// 재직렬화하지 않고 로봇 원문을 그대로 중계하므로(RobotEventListener.handleNavEvent)
// camelCase 로 바뀌지 않는다 — 같은 패킷의 robot_id·cells 와 같은 규칙이다.
// 첫 구현이 `patrolMask` 로 읽어 마스크가 FE 에 한 번도 도달하지 못했다.
//
// geometry 는 자기검증용 사본이다. 지도 격자와 어긋나면 마스크가 엉뚱한 칸을 가리키므로
// 버린다 — 엉뚱한 칸을 막는 것은 안 막느니만 못하다.
// 이름 판정과 격자 판정을 여기 한 곳에 모아 둔 이유는 tools/verify/check-869.mjs 가
// 실제 로봇 패킷 모양으로 이 함수를 직접 검증할 수 있게 하기 위해서다.
export function patrolMaskBlock(msg: any): any {
  const raw = msg?.patrol_mask ?? msg?.patrolMask
  if (!raw) return null
  const g = raw.geometry
  const aligned = !g || (g.w === msg.w && g.h === msg.h
    && Math.abs(g.res - msg.res) < 1e-9
    && Math.abs(g.ox - msg.ox) < 1e-9 && Math.abs(g.oy - msg.oy) < 1e-9)
  return aligned ? raw : null
}

// patrolMask 디코드(S15P11E101-869) — decodeMapSnapshot 과 같은 flat RLE 형식이라
// 새 디코더를 짜지 않고 같은 방식으로 편다. 셀 순서도 맵과 같은 그리드(w×h)다.
// 크기가 안 맞으면 던진다 — decodeMapSnapshot 과 같은 이유로, 조용히 어긋난 위치를
// 막는 것보다 버리고 이전 상태를 유지하는 편이 낫다(호출부가 catch 한다).
//
// 🔴 런 배열의 이름은 `cells` 다 — 지도의 `cells` 와 같은 이름·같은 형식이라는 것이
// 계약의 요점이다(patrol_mask_contract.md §2). 처음 구현은 `data` 로 읽어서 마스크가
// 항상 null 이었고, 그 결과 벽에 붙은 칸도 그대로 찍혔다. `data` 는 구버전 호환으로만 둔다.
export function decodePatrolMask(mask: any, w: number, h: number): Uint8Array | null {
  const runs = mask?.cells ?? mask?.data
  if (!runs?.length) return null
  const out = new Uint8Array(w * h)
  let i = 0
  for (let k = 0; k < runs.length; k += 2) {
    const v = runs[k] ? 1 : 0
    const n = runs[k + 1]
    out.fill(v, i, Math.min(i + n, out.length))
    i += n
  }
  if (i !== w * h) throw new Error(`마스크 크기 불일치: ${i} != ${w * h}`)
  return out
}

// --bb-scene-dark 토큰을 마스크 오버레이 색으로 쓴다(새 색을 만들지 않는다).
// 캔버스 픽셀 버퍼는 CSS 변수를 직접 못 읽어 여기서 한 번 RGB 로 풀어 둔다.
function maskDimColor() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--bb-scene-dark').trim()
    const n = parseInt(v.replace('#', ''), 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 150 }
  } catch {
    return { r: 13, g: 16, b: 23, a: 150 }
  }
}

// mask(1=가능·0=불가) → 오버레이 캔버스. 0 인 칸만 어둡게 칠하고 나머지는 투명하게 둬
// 배경(원본 격자/도면) 위에 그대로 얹을 수 있게 한다. bakeMap 과 같은 이유로 미리 굽는다 —
// 셀이 많아 매 프레임 순회하면 느리다.
export function bakeMask(mask: Uint8Array, w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const g = c.getContext('2d')!
  const img = g.createImageData(w, h)
  const d = img.data
  const dim = maskDimColor()
  for (let i = 0; i < w * h; i++) {
    // map 데이터와 같은 아래→위 순서 뒤집기(bakeMap 참고)
    const row = h - 1 - ((i / w) | 0)
    const col = i % w
    const j = (row * w + col) * 4
    if (mask[i] === 0) {
      d[j] = dim.r; d[j + 1] = dim.g; d[j + 2] = dim.b; d[j + 3] = dim.a
    } else {
      d[j + 3] = 0
    }
  }
  g.putImageData(img, 0, 0)
  return c
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

/**
 * 로봇이 화면 가운데 오도록 팬 오프셋을 옮긴다(S15P11E101-775).
 *
 * 배율(s)은 건드리지 않는다 — 따라간다고 확대까지 바뀌면 조작자가 보던 축척을 잃는다.
 * k 는 한 프레임에 목표로 다가가는 비율이다. 1 이면 즉시, 작을수록 부드럽다.
 */
export function followPose(view: any, cv: any, pose: any, k = 1) {
  if (!cv?.width || !cv?.height || !pose) return false
  if (!Number.isFinite(Number(pose.x)) || !Number.isFinite(Number(pose.y))) return false
  const wantX = cv.width / 2 - Number(pose.x) * view.s
  const wantY = cv.height / 2 + Number(pose.y) * view.s
  view.x += (wantX - view.x) * k
  view.y += (wantY - view.y) * k
  // init 은 건드리지 않는다. 배율을 정하는 것은 fitView 뿐이다 —
  // 여기서 세워 버리면 자세가 지도보다 먼저 온 경우 fitView 가 영영 돌지 않아
  // 기본 배율(60px/m)에 갇힌 채 화면이 텅 빈 것처럼 보인다.
  return true
}

// 맵을 캔버스에 맞춘다 (첫 MAP 수신 시 · 캔버스 크기가 바뀌었을 때)
export function fitView(view: any, cv: any, m: any) {
  if (!cv.width || !cv.height) return false
  const w = m.w * m.res, h = m.h * m.res
  view.s = Math.min(cv.width / w, cv.height / h) * 0.96   // 여백 12→4% (S15P11E101-911: 화면을 더 채운다)
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
  // 표시 회전을 먼저 되돌린다(현재 0 — S15P11E101-796). 화면에서 찍은 자리를 그리기 전
  // 좌표로 옮겨야 한다 — 안 그러면 조작자가 찍은 곳과 로봇이 가는 곳이 정반대가 된다.
  // DISPLAY_ROT 가 다시 0이 아니게 되어도 이 계산은 그대로 맞는다.
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

// patrolMask 상 이 좌표가 막혀 있는지(S15P11E101-869). mask 는 nav.map 과 같은 그리드다 —
// insideMap 과 같은 회전 축 변환을 재사용해 회전 도면에서도 같은 칸을 가리키게 한다.
// mask/m 이 없으면(아직 로봇이 안 보내는 경우) 항상 false — 기존 동작 그대로 둔다.
export function isMasked(mask: Uint8Array | null | undefined, m: any, x: any, y: any) {
  if (!mask || !insideMap(m, x, y)) return false
  let dx = x - m.ox
  let dy = y - m.oy
  const yaw = Number(m.oyaw) || 0
  if (yaw) {
    const c = Math.cos(-yaw), s2 = Math.sin(-yaw)
    const rx = dx * c - dy * s2
    const ry = dx * s2 + dy * c
    dx = rx; dy = ry
  }
  const col = Math.floor(dx / m.res)
  const row = Math.floor(dy / m.res)
  if (col < 0 || row < 0 || col >= m.w || row >= m.h) return false
  return mask[row * m.w + col] === 0
}

// 이 좌표가 '매핑된 자유공간'(흰색, ' ')인지(S15P11E101-911). 순찰 지점을 검은 벽('#')이나
// 아직 탐색 못 한 칸('.') — 즉 벽 바깥 — 에 찍지 못하게 막는 데 쓴다. bakeMap 과 같은 규약:
// data 는 아래→위 순서 문자열이고 32(' ')=자유, 35('#')=벽, 그 외=미탐색이다.
// 좌표 축 변환은 insideMap/isMasked 와 동일하게 originYaw 를 되돌린다.
// 원본 격자 문자열(m.data)이 없으면 판정할 수 없으므로 통과시킨다(기존 동작 유지).
export function isFree(m: any, x: any, y: any) {
  if (typeof m?.data !== 'string' || !insideMap(m, x, y)) return true
  let dx = x - m.ox
  let dy = y - m.oy
  const yaw = Number(m.oyaw) || 0
  if (yaw) {
    const c = Math.cos(-yaw), s2 = Math.sin(-yaw)
    const rx = dx * c - dy * s2
    const ry = dx * s2 + dy * c
    dx = rx; dy = ry
  }
  const col = Math.floor(dx / m.res)
  const row = Math.floor(dy / m.res)
  if (col < 0 || row < 0 || col >= m.w || row >= m.h) return false
  return m.data.charCodeAt(row * m.w + col) === 32   // ' ' 자유공간만 허용
}

// 맵 + 궤적 + 스캔 + 로봇 — nav.html 그대로
//
/**
 * 지도 표시 회전. 순수하게 보여 주는 각도이고 데이터는 건드리지 않는다.
 * SLAM·도면·로봇이 이 하나를 같이 써야 서로 어긋나지 않는다.
 *
 * S15P11E101-746 에서 180도(Math.PI)로 걸었으나, 실측 결과 북쪽이 여전히
 * 뒤집혀 보여 그 보정 방향 자체가 틀렸던 것으로 판명됐다(S15P11E101-796).
 * 0으로 되돌린다 — 원본 데이터(격자·origin·resolution·pose)가 이미 올바른
 * 방향이라는 뜻이고, 여기서 추가로 돌릴 필요가 없다.
 */
export const DISPLAY_ROT = 0

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

// AprilTag 점검 지점 그리기 (S15P11E101-787)
//
// 한 점검 지점은 두 좌표다 — 태그가 붙은 벽 위(target)와 그것을 보려고 로봇이
// 서는 자리(viewpoint). 둘을 잇지 않으면 화면에 점이 두 배로 늘어난 것으로만 보인다.
//
// 순찰 지점(초록 동그라미 + 번호)과 반드시 달라야 한다. 같은 모양이면 조작자가
// '로봇이 지나가는 곳' 과 '로봇이 서서 들여다보는 곳' 을 구분하지 못한다.
//   대기 후보 : 점선 · 반투명    — 아직 아무 효력이 없다
//   확정 지점 : 실선 · 불투명    — 순찰 목적지다
//   꺼 둔 지점 : 회색            — 남아 있지만 이번 순찰에서 들르지 않는다
const INSPECT_WAIT = '#c9a227'
const INSPECT_DONE = '#e0483f'
const INSPECT_OFF = '#8b8f9a'

/**
 * 캔버스가 rot 만큼 회전된 상태에서도 글자를 똑바로 그린다(S15P11E101-795).
 *
 * drawNav 는 표시 회전(DISPLAY_ROT, 현재 0 — S15P11E101-796)과 heading-up 회전을
 * 캔버스 변환으로 건 채 배경·경로·점검 지점을 그린다 — 위치는 그 변환 아래에서 맞게
 * 계산되지만, fillText 는 그 회전을 그대로 받아 글자 자체가 뒤집힌다.
 * DISPLAY_ROT 는 0이라도 heading-up(진행방향 위) 모드에서는 여전히 회전이 걸리므로,
 * 이 되돌림은 그 경우를 위해 남겨 둔다 — 글자를 그릴 때만 반대로 돌려 화면 기준으로
 * 똑바로 서게 한다.
 */
// 순찰 지점 방향(heading) 손잡이 — 지점 중심에서 이만큼(화면 픽셀) 떨어진 곳에 그린다.
// LiveNavMap 의 히트 판정이 같은 값을 써야 손잡이를 보이는 자리에서 잡을 수 있어 내보낸다.
export const WAYPOINT_HANDLE_PX = 34
const WAYPOINT_ARROW_PX = 22       // 화살촉 위치(S15P11E101-790 원본 값)
const WAYPOINT_BADGE_PX = 54       // 각도 뱃지 위치 — 손잡이 바로 바깥

// yaw(radians) → 사람이 읽는 정수 도(degree). **표시 전용이다.**
//
// 계약(waypoints.ts 머리말)은 radians·map 프레임·반시계 + · 0 = map +X 이고, 그 값이 그대로
// 서버·로봇으로 간다. 도로 바꾸는 곳은 화면 경계인 이 함수 하나뿐이다.
// 0=동 · 90=북 으로 읽히도록 0~359 로 감는다 — 계약값 자체는 (-π, π] 그대로 둔다.
export const yawToDegrees = (yaw: number) => ((Math.round((yaw * 180) / Math.PI) % 360) + 360) % 360

// 각도 뱃지 — 캔버스 회전을 되돌려 똑바로 세운 알약 위에 도(degree)를 적는다.
function drawHeadingBadge(g: any, text: string, x: number, y: number, rot: any) {
  g.save()
  g.translate(x, y)
  g.rotate(-rot)
  g.font = 'bold 10.5px system-ui, sans-serif'
  const w = g.measureText(text).width + 11, h = 15
  g.fillStyle = '#3ddc97'
  g.beginPath()
  if (g.roundRect) g.roundRect(-w / 2, -h / 2, w, h, 7)
  else g.rect(-w / 2, -h / 2, w, h)
  g.fill()
  g.fillStyle = '#0b0d11'
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, 0, 0.5)
  g.restore()
}

function drawUprightLabel(g: any, text: string, x: any, y: any, rot: any, fill = '#0b0d11') {
  g.save()
  g.translate(x, y)
  g.rotate(-rot)
  g.fillStyle = fill
  g.font = 'bold 11px system-ui, sans-serif'
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, 0, 0.5)
  g.restore()
}

function drawInspection(g: any, sx: any, sy: any, view: any, inspect: any, textRot: any = 0) {
  const items = [
    ...(inspect.candidates || []).map((c: any) => ({ item: c, id: c.candidateId, done: false })),
    ...(inspect.points || []).map((p: any) => ({ item: p, id: p.pointId, done: true })),
  ]
  if (!items.length) return
  const R = Math.max(5, view.s * 0.09)

  for (const { item, id, done } of items) {
    const t = item?.target
    const v = item?.viewpoint
    if (!t || !Number.isFinite(Number(t.x)) || !Number.isFinite(Number(t.y))) continue
    const off = done && item.enabled === false
    const color = off ? INSPECT_OFF : (done ? INSPECT_DONE : INSPECT_WAIT)
    const picked = !!inspect.selectedId && inspect.selectedId === id
    const TX = sx(t.x), TY = sy(t.y)

    g.save()
    g.globalAlpha = done ? 1 : 0.66      // 대기 후보는 반투명 — 아직 효력이 없다

    // 정차 지점과 태그를 잇는다. 이 선이 없으면 두 점이 남남으로 보인다.
    if (v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) {
      const VX = sx(v.x), VY = sy(v.y)
      g.strokeStyle = color; g.lineWidth = 1.5
      g.setLineDash(done ? [] : [5, 4])
      g.beginPath(); g.moveTo(VX, VY); g.lineTo(TX, TY); g.stroke()
      g.setLineDash([])

      // 정차 지점 — yaw 방향 화살촉. 어느 쪽을 보고 서는지가 이 점의 뜻이다.
      const a = Number(v.yaw) || 0
      const L = R * 2.0
      g.fillStyle = color
      g.beginPath()
      g.moveTo(VX + Math.cos(a) * L, VY - Math.sin(a) * L)
      g.lineTo(VX + Math.cos(a + 2.5) * L * 0.62, VY - Math.sin(a + 2.5) * L * 0.62)
      g.lineTo(VX + Math.cos(a - 2.5) * L * 0.62, VY - Math.sin(a - 2.5) * L * 0.62)
      g.closePath(); g.fill()
      // 서는 자리 자체는 작은 테두리 원. 화살촉만 있으면 어디에 서는지 모른다.
      g.strokeStyle = color; g.lineWidth = 1.5
      g.beginPath(); g.arc(VX, VY, R * 0.5, 0, Math.PI * 2); g.stroke()
    }

    // 태그 — 벽 위라 로봇이 갈 수 없는 자리다. 원이 아니라 마름모로 그려
    // 순찰 지점(동그라미)과 한눈에 갈린다.
    g.beginPath()
    g.moveTo(TX, TY - R); g.lineTo(TX + R, TY); g.lineTo(TX, TY + R); g.lineTo(TX - R, TY)
    g.closePath()
    g.fillStyle = color; g.fill()
    if (!done) { g.strokeStyle = color; g.lineWidth = 1.5; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]) }

    // 고른 것은 테두리를 둘러 화면에서 찾을 수 있게 한다
    if (picked) {
      g.globalAlpha = 1
      g.strokeStyle = '#ffffff'; g.lineWidth = 2
      g.beginPath(); g.arc(TX, TY, R * 1.9, 0, Math.PI * 2); g.stroke()
    }

    // 확정 지점은 순서를 쓴다 — 순찰이 도는 차례다
    if (done && Number.isFinite(Number(item.sequence))) {
      g.globalAlpha = 1
      drawUprightLabel(g, String(item.sequence), TX, TY, textRot)
    }
    g.restore()
  }
}

export function drawNav(g: any, cv: any, nav: any, view: any, headingUp = false, route: any = null, showPlan = true, overlays = true, inspect: any = null, bgColor = '#15171c', showCompass = true) {
  // 바탕색. 기본은 어두운 관제 톤이지만, 지도 탭·순찰 경로처럼 '흰 바닥' 으로 보여
  // 주고 싶은 화면은 밝은 색을 넘긴다(S15P11E101-822). 도면/격자는 이 위에 그려지고,
  // 이미지 바깥 여백이 이 색으로 채워져 바닥이 뷰 전체로 이어진다.
  g.fillStyle = bgColor
  g.fillRect(0, 0, cv.width, cv.height)
  if (!nav) return

  // 표시 회전(현재 0 — S15P11E101-796). DISPLAY_ROT 가 0이 아니게 되면 이 변환이
  // 배경·스캔·로봇·경로를 통째로 돌린다(지도만 돌리면 로봇이 어긋나므로 한 곳에서 건다).
  // heading-up(진행방향 위) 회전은 이 변환과 별개로 아래에서 추가된다.
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
  // 지금 캔버스에 걸려 있는 총 회전(S15P11E101-795). 글자를 그릴 때 이만큼 되돌려
  // 똑바로 세운다 — drawUprightLabel 에 넘긴다.
  const textRot = DISPLAY_ROT + (rotating ? nav.pose.yaw - Math.PI / 2 : 0)

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
    // 원본 격자(매핑 중)는 맵 경계에 딱 붙어, 경계 근처 벽이 배경(회색 미탐색 영역) 밖
    // 바닥색으로 삐져나와 보였다(사용자 지적 2026-08-10). 배경 이미지와 같은 변환으로
    // 맵보다 큰 회색 판을 먼저 깔아 벽을 감싼다 — 미탐색 셀(rgba 60,.35)과 같은 톤이라
    // 자연스럽게 이어진다. 도면(isPlan)은 자기 흰 배경이 있어 패딩하지 않는다. */
    const pad = bg.isPlan ? 0 : Math.max(wpx, hpx) * 0.10
    const drawBg = (dx: number, dy: number) => {
      if (pad > 0) {
        g.fillStyle = 'rgba(60,60,60,.35)'
        g.fillRect(dx - pad, dy - pad, wpx + pad * 2, hpx + pad * 2)
      }
      g.drawImage(bg.img, dx, dy, wpx, hpx)
    }
    if (yaw) {
      const ax = sx(bg.ox), ay = sy(bg.oy)      // 좌하단 = 회전축
      g.save()
      g.translate(ax, ay)
      g.rotate(-yaw)                            // 화면 y 는 아래로 자라므로 부호를 뒤집는다
      drawBg(0, -hpx)
      g.restore()
    } else {
      drawBg(sx(bg.ox), sy(bg.oy + bg.h * bg.res))
    }
  }

  // 순찰 가능 마스크 오버레이(S15P11E101-869) — 배경 위, 나머지 오버레이보다 먼저 그린다.
  // mask 는 항상 nav.map(원본 격자) 기준 그리드다 — 지금 보이는 배경이 도면이어도
  // 좌표는 원본 격자 원점·해상도로 배치해야 실제로 막힌 칸과 어긋나지 않는다.
  const m = nav.map
  if (m?.mask && nav.maskCanvas) {
    const yaw = Number(m.oyaw) || 0
    const mwpx = m.w * m.res * view.s
    const mhpx = m.h * m.res * view.s
    if (yaw) {
      const ax = sx(m.ox), ay = sy(m.oy)
      g.save()
      g.translate(ax, ay)
      g.rotate(-yaw)
      g.drawImage(nav.maskCanvas, 0, -mhpx, mwpx, mhpx)
      g.restore()
    } else {
      g.drawImage(nav.maskCanvas, sx(m.ox), sy(m.oy + m.h * m.res), mwpx, mhpx)
    }
  }

  // 도면만 보는 화면(지도 탭)이라도 실시간 로봇 위치는 보여 준다(S15P11E101 콘솔 정리) —
  // 스캔·궤적·순찰 경로 등 잡다한 오버레이는 빼되, 로봇 마커만 얹는다.
  if (!overlays) {
    drawRobotMarker(g, nav.pose, sx, sy, view)
    if (rotating) g.restore()
    g.restore()
    if (showCompass) drawCompass(g, cv, (rotating ? nav.pose.yaw - Math.PI / 2 : 0) + DISPLAY_ROT)
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
      // 방향(heading) 화살표 — 로봇이 이 지점에서 바라볼 방향(S15P11E101-790).
      // yaw 가 없으면(자동) 그리지 않는다 — 로봇이 가까운 구조물을 스스로 바라본다.
      // 원보다 먼저 그려 번호가 화살표에 가리지 않게 한다.
      // Number(null) === 0 이라 '자동'(null)이 명시적 0도(동쪽)로 오인돼 그려지던 버그(S15P11E101-797).
      // null·undefined 는 반드시 먼저 걸러야 한다.
      if (w.yaw != null && Number.isFinite(Number(w.yaw))) {
        const a = Number(w.yaw)
        // map 프레임 yaw 를 화면으로 놓는다: 화면 y 는 아래로 자라므로 sin 만 부호를 뒤집는다
        // (sy 와 같은 규칙). 반대로 화면→yaw 는 canvasToWorld 로 먼저 map 프레임에 돌려놓고 잰다.
        const L = WAYPOINT_ARROW_PX, hx = X + Math.cos(a) * L, hy = Y - Math.sin(a) * L
        const kx = X + Math.cos(a) * WAYPOINT_HANDLE_PX, ky = Y - Math.sin(a) * WAYPOINT_HANDLE_PX
        g.strokeStyle = '#3ddc97'; g.lineWidth = 2.5
        g.beginPath(); g.moveTo(X, Y); g.lineTo(kx, ky); g.stroke()
        g.fillStyle = '#3ddc97'
        g.beginPath()
        g.moveTo(hx, hy)
        g.lineTo(hx + Math.cos(a + 2.6) * 7, hy - Math.sin(a + 2.6) * 7)
        g.lineTo(hx + Math.cos(a - 2.6) * 7, hy - Math.sin(a - 2.6) * 7)
        g.closePath(); g.fill()
        // 잡고 돌리는 손잡이. 끝에 무언가 '쥘 것'이 보여야 돌릴 수 있다는 걸 안다.
        g.fillStyle = '#0b0d11'; g.lineWidth = 2
        g.beginPath(); g.arc(kx, ky, 6, 0, Math.PI * 2); g.fill(); g.stroke()
        // 정한 방향은 숫자로도 읽을 수 있어야 한다 — 드래그 중에도 미리보기 yaw 로 함께 갱신된다.
        drawHeadingBadge(g, `${yawToDegrees(a)}°`, X + Math.cos(a) * WAYPOINT_BADGE_PX, Y - Math.sin(a) * WAYPOINT_BADGE_PX, textRot)
      }
      g.fillStyle = '#3ddc97'
      g.beginPath(); g.arc(X, Y, 9, 0, Math.PI * 2); g.fill()
      // 번호는 뒤집힌 캔버스 회전을 되돌려 똑바로 세운다(S15P11E101-795) — 그냥
      // fillText 하면 표시 회전(북쪽 뒤집기)을 그대로 받아 숫자가 위아래로 뒤집혀 보인다.
      drawUprightLabel(g, String(i + 1), X, Y, textRot)
    })
  }

  // 점검 지점 — 로봇 마커보다 먼저 그린다. 로봇이 지점 위에 서 있어도 로봇이 위다.
  if (inspect) drawInspection(g, sx, sy, view, inspect, textRot)

  // 로봇 마커 (점 + 방향 화살표) — pose 는 TF 미확보 시 없을 수 있다
  drawRobotMarker(g, p, sx, sy, view)

  if (rotating) g.restore()

  // 표시 회전을 여기서 푼다. 나침반은 화면 좌표계에 그려야 하기 때문이다.
  g.restore()
  // 방위 표시 — 회전 여부와 무관하게 북쪽이 어디인지 항상 알 수 있게 화면 좌표계에 그린다.
  // 표시 회전도 화면이 돌아간 각도이므로 함께 더한다 — 안 더하면 N 이 반대를 가리킨다.
  // showCompass=false 인 화면(매핑 탭, S15P11E101-814)은 나침반을 아예 그리지 않는다.
  if (showCompass) drawCompass(g, cv, (rotating ? nav.pose.yaw - Math.PI / 2 : 0) + DISPLAY_ROT)
}

// 로봇 마커(점 + 진행방향 화살표). 평면(도면만) 뷰와 오버레이 뷰 양쪽에서 같은 모양으로 그린다.
function drawRobotMarker(g: any, p: any, sx: any, sy: any, view: any) {
  if (!p) return
  const X = sx(p.x), Y = sy(p.y), R = Math.max(5, view.s * 0.10)
  g.fillStyle = '#f0c98a'
  g.beginPath(); g.arc(X, Y, R, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#f0c98a'; g.lineWidth = 2.5
  g.beginPath(); g.moveTo(X, Y)
  g.lineTo(X + Math.cos(p.yaw) * R * 2.4, Y - Math.sin(p.yaw) * R * 2.4)
  g.stroke()
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
