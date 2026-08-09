// 정제 2D 도면 (S15P11E101-524).
//
// 매핑이 끝나면 서버가 원본 점유격자를 정제한 도면을 만들어 활성화하고
// /topic/mapping 으로 FLOORPLAN_READY 를 알린다(S15P11E101-518).
//
//   FLOORPLAN_READY  { type, robotId, mapId, imageUrl }
//   GET /api/maps/active → Detail { id, name, imageUrl, widthPx, heightPx,
//                                   resolution, originX, originY, active, kind, ... }
//   kind: RAW(원본 점유격자) | FLOORPLAN(정제 도면) · null 이면 RAW 취급
//
// 이미지도 JWT 인가 대상이라 <img src> 로는 헤더를 못 싣는다 — blob 으로 받아
// objectURL 로 렌더한다(가이드 §8.3).

import { authedGet } from './authApi.ts'
import { REST_BASE } from './config.ts'

export const KIND_FLOORPLAN = 'FLOORPLAN'

/**
 * @param {unknown} msg
 * @returns {msg is import('./contracts').FloorplanReady}
 */
export const isFloorplanReady = (msg: any) => /** @type {any} */ (msg)?.type === 'FLOORPLAN_READY'
/** @param {import('./contracts').MapDetail | null | undefined} detail */
export const isFloorplan = (detail: any) => (detail?.kind || 'RAW').toUpperCase() === KIND_FLOORPLAN

// 도면 이미지를 blob 으로 받아 디코드까지 끝낸 Image 를 돌려준다.
// 캔버스는 매 프레임 그리므로, 로드가 끝나지 않은 Image 를 넘기면 첫 프레임이 빈 화면이 된다.
/**
 * @param {string} imageUrl
 * @param {string | null | undefined} accessToken
 * @returns {Promise<{ img: HTMLImageElement, url: string }>}
 */
async function loadImage(imageUrl: any, accessToken: any) {
  const res = await fetch(`${REST_BASE}${imageUrl}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  })
  if (!res.ok) throw new Error(`도면 이미지를 받지 못했습니다 (HTTP ${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise((ok, fail) => {
      img.onload = ok
      img.onerror = () => fail(new Error('도면 이미지를 디코드하지 못했습니다.'))
      img.src = url
    })
    return { img, url }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

// 활성 도면(메타 + 이미지)을 통째로 가져온다. 활성 맵이 없으면 null.
/**
 * @param {string | null | undefined} accessToken
 * @returns {Promise<import('./contracts').PlanLayer | null>}
 */
export async function loadActivePlan(accessToken: string | null | undefined) {
  const detail = await authedGet('/api/maps/active', accessToken)
  if (!detail?.imageUrl) return null
  // 좌표 정합의 기준은 격자 메타다(S15P11E101-745). 서버가 그 API 를 주면 그것이 정답이고,
  // 없으면(404) 도면 상세의 같은 값으로 되돌아간다 — 한쪽만 있어도 지도가 어긋나지 않게.
  const grid = await authedGet('/api/maps/active/grid', accessToken).catch(() => null)
  const pick = (...vals: any[]) => vals.find((v) => Number.isFinite(Number(v)))
  const { img, url } = await loadImage(detail.imageUrl, accessToken)
  return {
    id: detail.id,
    name: detail.name,
    kind: (detail.kind || 'RAW').toUpperCase(),
    img,
    url,
    // 이 도면의 정체성. 경보 핀이 "이 지도의 좌표계에서 찍힌 것인지" 판정하는 데 쓴다.
    // 재매핑하면 map 프레임 원점이 새로 잡히므로 이전 지도의 x,y 는 새 지도 위에서
    // 아무 의미가 없다 — 그리면 없는 자리에 불이 난 것처럼 보인다.
    //   sourceMapId : FLOORPLAN 은 RAW 에서 파생된다. 도면 생성 전 짧은 구간에 들어온
    //                 이벤트는 RAW 의 id 로 태깅되므로 둘 다 같은 지도로 본다.
    //   createdAt   : 서버가 mapId 를 아직 안 실어 줄 때의 폴백 기준선.
    sourceMapId: detail.sourceMapId,
    createdAt: detail.createdAt,
    // drawNav 가 쓰는 맵 기하와 같은 형태로 맞춘다(미터 단위 원점 + m/px)
    w: Number(pick(grid?.cols, grid?.columns, detail.widthPx)),
    h: Number(pick(grid?.rows, detail.heightPx)),
    res: Number(pick(grid?.cellResolution, detail.resolution)),
    ox: Number(pick(grid?.originX, detail.originX)),
    oy: Number(pick(grid?.originY, detail.originY)),
    // ROS map 규약의 원점 회전각(radians). 서버가 주지 않으면 0 — 축에 나란한 맵이다.
    oyaw: Number(pick(grid?.originYaw, detail.originYaw, 0)),
  }
}

// objectURL 은 명시적으로 풀어야 한다 — 매핑을 반복하면 blob 이 계속 쌓인다.
/** @param {{ url?: string } | null | undefined} plan */
export function releasePlan(plan: { url?: string } | null | undefined) {
  if (plan?.url) URL.revokeObjectURL(plan.url)
}

// 기하가 온전해야 지도 위에 겹칠 수 있다. 하나라도 없으면 그리지 않는다.
/** @param {import('./contracts').PlanLayer | null | undefined} plan */
export const planDrawable = (plan: any) => !!plan?.img
  && Number.isFinite(plan.w) && Number.isFinite(plan.h)
  && Number.isFinite(plan.res) && Number.isFinite(plan.ox) && Number.isFinite(plan.oy)
