// 구역 (S15P11E101-770)
//
// 조작자에게 좌표는 뜻이 없다. '1.2, -0.4 m' 를 보고 어디인지 아는 사람은 없다 —
// '창고 구역 · 분전반 A 근처(1.2m)' 라야 몸을 움직일 수 있다.
//
// 라벨 판정은 FE 에서 한다(BE 협의, 2026-08-06). 서버에도 /api/zones/resolve 가 있지만
// 로봇이 움직일 때마다 요청을 보낼 수는 없다 — 목록을 한 번 받아 두고 여기서 판정한다.
// 대신 서버와 같은 규칙을 지켜야 한다. 규칙은 아래 두 개다.

import { authedGet, authedSend } from './authApi.ts'
import type { Zone, ZoneLandmark } from './contracts.d.ts'

export function fetchZones(accessToken: string | null | undefined) {
  return authedGet('/api/zones', accessToken) as Promise<Zone[]>
}

export function createZone(body: Partial<Zone>, accessToken: string | null | undefined) {
  return authedSend('/api/zones', accessToken, { method: 'POST', body })
}

export function updateZone(id: string, body: Partial<Zone>, accessToken: string | null | undefined) {
  return authedSend(`/api/zones/${encodeURIComponent(id)}`, accessToken, { method: 'PUT', body })
}

export function deleteZone(id: string, accessToken: string | null | undefined) {
  return authedSend(`/api/zones/${encodeURIComponent(id)}`, accessToken, { method: 'DELETE' })
}

/**
 * 활성 맵 경계로 rows×cols 격자를 만든다. 서버가 만든다 — FE 는 버튼만 둔다.
 * 기존 구역이 있으면 409 다. 갈아엎으려면 replace 를 준다.
 */
export function seedGrid(
  { rows = 3, cols = 3, replace = false },
  accessToken: string | null | undefined,
) {
  const q = new URLSearchParams({ rows: String(rows), cols: String(cols) })
  if (replace) q.set('replace', 'true')
  return authedSend(`/api/zones/seed-grid?${q}`, accessToken, { method: 'POST' })
}

// ---- 로컬 판정 ----

/** 사각형 넓이. 겹칠 때 어느 쪽을 고를지 가르는 값이다. */
const areaOf = (z: Zone) => Math.abs((z.x2 - z.x1) * (z.y2 - z.y1))

const inside = (z: Zone, x: number, y: number) =>
  x >= Math.min(z.x1, z.x2) && x <= Math.max(z.x1, z.x2)
  && y >= Math.min(z.y1, z.y2) && y <= Math.max(z.y1, z.y2)

/**
 * 좌표가 속한 구역. 겹치면 **면적이 작은 쪽**이 이긴다 —
 * 서버(/api/zones/resolve)와 같은 규칙이다. 큰 구역이 이기면 '창고' 안의
 * '분전반실' 이 영영 안 잡힌다.
 */
export function zoneAt(zones: Zone[] | null | undefined, x: number, y: number): Zone | null {
  const hits = (zones || []).filter((z) => inside(z, x, y))
  if (!hits.length) return null
  return hits.reduce((a, b) => (areaOf(b) < areaOf(a) ? b : a))
}

/** 이보다 멀면 '근처' 라고 하지 않는다. 20m 떨어진 설비를 근처라 하면 거짓말이다. */
export const NEAR_M = 3.0

/**
 * 가장 가까운 랜드마크(설비·순찰 지점). NEAR_M 밖이면 null 이다.
 */
export function nearestLandmark(
  marks: ZoneLandmark[] | null | undefined, x: number, y: number,
): (ZoneLandmark & { distanceM: number }) | null {
  let best: (ZoneLandmark & { distanceM: number }) | null = null
  for (const m of marks || []) {
    if (!Number.isFinite(Number(m?.x)) || !Number.isFinite(Number(m?.y))) continue
    const d = Math.hypot(Number(m.x) - x, Number(m.y) - y)
    if (d > NEAR_M) continue
    if (!best || d < best.distanceM) best = { ...m, distanceM: Math.round(d * 10) / 10 }
  }
  return best
}

/**
 * 화면에 쓸 위치 문구.
 *   '창고 · 분전반 A 근처(1.2m)'  구역 + 가까운 랜드마크
 *   '창고'                       구역만
 *   '분전반 A 근처(0.8m)'        구역은 없고 랜드마크만
 *   '(1.20, -0.40) m'            둘 다 없을 때 — 좌표라도 준다
 */
export function locationLabel(
  zones: Zone[] | null | undefined,
  marks: ZoneLandmark[] | null | undefined,
  x: number | null | undefined,
  y: number | null | undefined,
): string {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return '—'
  const px = Number(x)
  const py = Number(y)
  const zone = zoneAt(zones, px, py)
  const near = nearestLandmark(marks, px, py)
  const parts: string[] = []
  if (zone?.name) parts.push(zone.name)
  if (near?.name) parts.push(`${near.name} 근처(${near.distanceM}m)`)
  if (parts.length) return parts.join(' · ')
  return `(${px.toFixed(2)}, ${py.toFixed(2)}) m`
}

/**
 * 다시 계산할 만큼 움직였는가.
 * 라벨은 몇 미터짜리 구역 이름이라 손 떨림 수준의 이동으로 바꿔 봐야 같은 글자가 나온다 —
 * 0.5m 안쪽이면 계산을 건너뛴다.
 */
export const MOVED_M = 0.5
export function movedEnough(
  prev: { x: number, y: number } | null | undefined,
  x: number, y: number,
) {
  if (!prev) return true
  return Math.hypot(x - prev.x, y - prev.y) >= MOVED_M
}
