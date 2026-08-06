// 2D 도면을 압출(layer-stacking) 2.5D 로 보여주기 위한 준비 (S15P11E101-676).
//
// 데이터는 끝까지 2D 도면이다. 진짜 3D 재구성이 아니라 화면에서만 기울인 연출이다 —
// 벽 픽셀만 켜진 이미지를 z 축으로 여러 층 쌓아 기둥처럼 보이게 한다.
// 면 3개를 각각 그리는 방식은 이음새와 z-fighting 이 생겨 쓰지 않는다.
//
// 이 파일은 '무엇을 쌓을지' 만 만든다. 쌓고 기울이는 것은 CSS 가 한다.

/** 벽 판정 임계. 서버 도면은 흰 배경 + 검은 벽인 순수 흑백이라 밝기만 보면 된다. */
const WALL_THRESHOLD = 128

// 벽/장애물 구분 (S15P11E101-777)
//
// BE 가 격자를 3값(0 자유 / 1 벽 / 2 장애물)으로 내보내기로 했다. 도면은 PNG 로 오므로
// 그 세 번째 값은 중간 회색으로 찍혀 온다 — 밝기 띠로 가른다.
//   lum <  OBSTACLE_LO            벽      (지금의 순수 흑백 도면에서 검정 0)
//   OBSTACLE_LO ≤ lum < OBSTACLE_HI  장애물 (중간 회색)
//   그 위                          자유    (흰 배경 255)
//
// 지금 도면은 0 아니면 255 뿐이라 이 띠는 비어 있다. 그래서 BE 가 3값을 내보내기
// 전까지는 obstacleRatio 가 0 이고 화면도 지금과 똑같다 — 먼저 넣어 두고 기다린다.
// BE 가 정하는 회색값이 이 띠 밖이면 여기만 고치면 된다.
const OBSTACLE_LO = 96
const OBSTACLE_HI = 200

/**
 * 벽을 몇 픽셀 깎을지 (S15P11E101-777).
 *
 * 도면의 벽은 실제보다 두껍게 그려져 있어 기둥이 방을 잡아먹는다. 양쪽에서 이만큼
 * 깎는다. 다만 얇은 벽은 통째로 사라지므로 능선(가운데 심)은 남긴다 —
 * 벽이 없어지면 방이 뚫린 것으로 읽혀, 두꺼운 것보다 나쁘다.
 */
const WALL_ERODE = 1

/**
 * 벽 픽셀에서 '가장 가까운 비벽까지의 맨해튼 거리'. 두 번 훑으면 구해진다.
 * 벽 안쪽일수록 값이 크다 — 그 값으로 겉을 깎고 심을 남긴다.
 */
function distanceToEdge(wall: Uint8Array, w: number, h: number) {
  const INF = w + h
  const d = new Int32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = wall[i] ? INF : 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!d[i]) continue
      // 맵 밖은 비벽으로 본다 — 도면 가장자리에 닿은 벽을 안쪽으로 착각하지 않게
      const up = y > 0 ? d[i - w] : 0
      const left = x > 0 ? d[i - 1] : 0
      d[i] = Math.min(d[i], up + 1, left + 1)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!d[i]) continue
      const down = y < h - 1 ? d[i + w] : 0
      const right = x < w - 1 ? d[i + 1] : 0
      d[i] = Math.min(d[i], down + 1, right + 1)
    }
  }
  return d
}

/**
 * 벽을 얇게. 겉에서 WALL_ERODE 만큼 깎되, 능선(주변보다 안쪽인 픽셀)은 남긴다.
 * 그래서 두꺼운 벽은 얇아지고 1~2px 짜리 얇은 벽은 그대로 살아남는다.
 */
function thinWalls(wall: Uint8Array, w: number, h: number) {
  if (WALL_ERODE <= 0) return wall
  const d = distanceToEdge(wall, w, h)
  const out = new Uint8Array(wall.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!d[i]) continue
      if (d[i] > WALL_ERODE) { out[i] = 1; continue }
      // 능선이면 남긴다 — 이 픽셀을 지우면 이 자리 벽이 통째로 없어진다
      const up = y > 0 ? d[i - w] : 0
      const down = y < h - 1 ? d[i + w] : 0
      const left = x > 0 ? d[i - 1] : 0
      const right = x < w - 1 ? d[i + 1] : 0
      if (d[i] >= up && d[i] >= down && d[i] >= left && d[i] >= right) out[i] = 1
    }
  }
  return out
}

/** 층 수 기본값. 저사양에서는 이 값부터 줄인다 — 픽셀 수보다 층 수가 비용에 더 민감하다. */
export const WALL_H = 40

/**
 * 도면이 크다(원본 x10 업스케일 + deskew 패딩으로 수천 px 가 될 수 있다).
 * 긴 변을 이 값에 맞춰 줄인다. 줄인 비율은 로봇 좌표에도 똑같이 적용해야 한다.
 */
const MAX_EDGE = 720

/** @returns 긴 변이 MAX_EDGE 를 넘지 않도록 하는 축소 비율(1 이하) */
export function downscaleOf(w: number, h: number) {
  const longEdge = Math.max(w, h)
  return longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1
}

export interface ExtrudeSource {
  /** 벽만 불투명한 마스크 (CSS mask-image 로 쓴다) */
  maskUrl: string
  /** 장애물만 불투명한 마스크. 장애물이 없으면 null 이다(S15P11E101-777). */
  obstacleUrl: string | null
  /** 축소 후 픽셀 크기 */
  w: number
  h: number
  /** 원본 대비 축소 비율 — 로봇 좌표 환산에 쓴다 */
  scale: number
  /** 벽으로 판정된 픽셀 비율(0~1). 0 이면 압출할 것이 없다. */
  wallRatio: number
  /** 깎기 전 벽 비율. 얼마나 얇아졌는지 재는 값이다. */
  wallRatioRaw: number
  /** 장애물로 판정된 픽셀 비율(0~1). BE 가 3값을 내보내기 전에는 0 이다. */
  obstacleRatio: number
}

const toUrl = (cv: HTMLCanvasElement) => new Promise<string>((resolve, reject) => {
  cv.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('도면을 이미지로 만들지 못했습니다.'))), 'image/png')
})

/**
 * 도면 이미지에서 압출에 쓸 재료를 만든다.
 *
 * blob → objectURL 로 받은 이미지는 same-origin 이라 canvas 가 오염되지 않는다.
 * 그래서 getImageData 로 픽셀을 읽을 수 있다.
 *
 * @param img 이미 디코드가 끝난 도면 이미지 (floorplan.loadActivePlan 이 준다)
 */
export async function buildExtrudeSource(img: HTMLImageElement): Promise<ExtrudeSource> {
  const sw = img.naturalWidth || img.width
  const sh = img.naturalHeight || img.height
  if (!sw || !sh) throw new Error('도면 크기를 읽지 못했습니다.')

  const scale = downscaleOf(sw, sh)
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))

  // 도면 픽셀을 읽기 위한 임시 캔버스. 바닥에는 이 그림을 깔지 않는다 —
  // 바닥은 흰색 한 장이다(S15P11E101-777). 도면의 회색이 그대로 깔려 있으면
  // 기둥이 선 자리와 그림자·미탐색 얼룩이 뒤섞여 어디가 벽인지 눈이 헤맨다.
  const read = document.createElement('canvas')
  read.width = w; read.height = h
  const fg = read.getContext('2d', { willReadFrequently: true })
  if (!fg) throw new Error('캔버스를 만들지 못했습니다.')
  fg.imageSmoothingEnabled = true
  fg.drawImage(img, 0, 0, w, h)

  const src = fg.getImageData(0, 0, w, h)
  const n = w * h
  const wall = new Uint8Array(n)
  const obst = new Uint8Array(n)
  let obstacles = 0
  for (let p = 0; p < n; p++) {
    const i = p * 4
    const a = src.data[i + 3]
    // 투명한 자리는 벽이 아니다. 알파를 무시하면 투명 배경이 검정(밝기 0)으로 읽혀
    // 도면 전체가 벽이 된다.
    const lum = a < 8 ? 255
      : 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2]
    if (lum < OBSTACLE_LO) wall[p] = 1
    else if (lum < OBSTACLE_HI) { obst[p] = 1; obstacles++ }
  }
  let rawWalls = 0
  for (let p = 0; p < n; p++) if (wall[p]) rawWalls++

  const thin = thinWalls(wall, w, h)
  let walls = 0
  for (let p = 0; p < n; p++) if (thin[p]) walls++

  // 알파만 쓰므로 색은 흰색으로 통일한다 — 층마다 색을 입히는 것은 CSS 가 한다.
  const toMask = (bits: Uint8Array) => {
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const g = cv.getContext('2d')
    if (!g) throw new Error('캔버스를 만들지 못했습니다.')
    const out = g.createImageData(w, h)
    for (let p = 0; p < n; p++) {
      if (!bits[p]) continue
      const i = p * 4
      out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255
    }
    g.putImageData(out, 0, 0)
    return cv
  }

  const maskUrl = await toUrl(toMask(thin))
  // 장애물이 하나도 없으면 빈 마스크를 만들지 않는다 — 빈 층을 40장 쌓을 이유가 없다
  const obstacleUrl = obstacles ? await toUrl(toMask(obst)) : null
  return {
    maskUrl,
    obstacleUrl,
    w,
    h,
    scale,
    wallRatio: walls / n,
    wallRatioRaw: rawWalls / n,
    obstacleRatio: obstacles / n,
  }
}

/** objectURL 은 명시적으로 풀어야 한다 — 매핑을 반복하면 blob 이 쌓인다. */
export function releaseExtrudeSource(s: ExtrudeSource | null | undefined) {
  if (!s) return
  URL.revokeObjectURL(s.maskUrl)
  if (s.obstacleUrl) URL.revokeObjectURL(s.obstacleUrl)
}

/**
 * map 프레임 미터 좌표 → 압출 씬의 픽셀 좌표.
 *
 * 티켓의 표준 변환에 originYaw 를 더한 것이다.
 *   px = (worldX - originX) / resolution
 *   py = heightPx - (worldY - originY) / resolution      ← ROS 맵은 y 축이 위로 자란다
 *
 * 티켓 본문에는 yaw 가 빠져 있지만, ROS map 규약의 origin 은 회전각을 함께 갖고
 * 기존 2D 지도(navMap.ts)가 이미 그것을 반영해 그린다. 여기서 빼면 회전된 맵에서
 * 2D 와 2.5D 의 로봇 위치가 서로 어긋난다. yaw 가 0 이면 티켓 공식과 완전히 같다.
 *
 * @param scale buildExtrudeSource 가 돌려준 축소 비율. 도면을 줄였으면 좌표도 같이 줄인다.
 */
export function worldToPlanPx(
  plan: { res: number, ox: number, oy: number, h: number, oyaw?: number },
  worldX: number, worldY: number, scale = 1,
) {
  let dx = worldX - plan.ox
  let dy = worldY - plan.oy
  const yaw = Number(plan.oyaw) || 0
  if (yaw) {
    const c = Math.cos(-yaw), s = Math.sin(-yaw)
    const rx = dx * c - dy * s
    const ry = dx * s + dy * c
    dx = rx; dy = ry
  }
  return {
    x: (dx / plan.res) * scale,
    y: (plan.h - dy / plan.res) * scale,
  }
}
