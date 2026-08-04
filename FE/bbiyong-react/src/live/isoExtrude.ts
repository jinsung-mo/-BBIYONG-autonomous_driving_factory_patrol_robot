// 2D 도면을 압출(layer-stacking) 2.5D 로 보여주기 위한 준비 (S15P11E101-676).
//
// 데이터는 끝까지 2D 도면이다. 진짜 3D 재구성이 아니라 화면에서만 기울인 연출이다 —
// 벽 픽셀만 켜진 이미지를 z 축으로 여러 층 쌓아 기둥처럼 보이게 한다.
// 면 3개를 각각 그리는 방식은 이음새와 z-fighting 이 생겨 쓰지 않는다.
//
// 이 파일은 '무엇을 쌓을지' 만 만든다. 쌓고 기울이는 것은 CSS 가 한다.

/** 벽 판정 임계. 서버 도면은 흰 배경 + 검은 벽인 순수 흑백이라 밝기만 보면 된다. */
const WALL_THRESHOLD = 128

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
  /** 바닥에 깔 도면 그림 */
  floorUrl: string
  /** 축소 후 픽셀 크기 */
  w: number
  h: number
  /** 원본 대비 축소 비율 — 로봇 좌표 환산에 쓴다 */
  scale: number
  /** 벽으로 판정된 픽셀 비율(0~1). 0 이면 압출할 것이 없다. */
  wallRatio: number
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

  const floor = document.createElement('canvas')
  floor.width = w; floor.height = h
  const fg = floor.getContext('2d')
  if (!fg) throw new Error('캔버스를 만들지 못했습니다.')
  fg.imageSmoothingEnabled = true
  fg.drawImage(img, 0, 0, w, h)

  // 벽만 남긴 마스크. 알파만 쓰므로 색은 흰색으로 통일한다 —
  // 층마다 색을 다르게 입히는 것은 CSS 가 한다(위로 갈수록 밝게).
  const src = fg.getImageData(0, 0, w, h)
  const mask = document.createElement('canvas')
  mask.width = w; mask.height = h
  const mg = mask.getContext('2d')
  if (!mg) throw new Error('캔버스를 만들지 못했습니다.')
  const out = mg.createImageData(w, h)
  let walls = 0
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3]
    // 투명한 자리는 벽이 아니다. 알파를 무시하면 투명 배경이 검정(밝기 0)으로 읽혀
    // 도면 전체가 벽이 된다.
    const lum = a < 8 ? 255
      : 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2]
    if (lum < WALL_THRESHOLD) {
      out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255
      walls++
    }
  }
  mg.putImageData(out, 0, 0)

  const [maskUrl, floorUrl] = await Promise.all([toUrl(mask), toUrl(floor)])
  return { maskUrl, floorUrl, w, h, scale, wallRatio: walls / (w * h) }
}

/** objectURL 은 명시적으로 풀어야 한다 — 매핑을 반복하면 blob 이 쌓인다. */
export function releaseExtrudeSource(s: ExtrudeSource | null | undefined) {
  if (!s) return
  URL.revokeObjectURL(s.maskUrl)
  URL.revokeObjectURL(s.floorUrl)
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
