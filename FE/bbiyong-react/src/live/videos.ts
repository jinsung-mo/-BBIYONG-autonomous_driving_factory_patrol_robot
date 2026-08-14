// 이벤트 상세 · 블랙박스 영상 — S15P11E101-628
//
// BE 계약: EventController(상세) · VideoController(영상).
//
//   GET /api/events/{eventId}          → EventLogDetailResponse (videos 포함)
//   GET /api/events/{eventId}/video    → VideoResponses.Summary[]
//   GET /api/videos/{id}/stream        → Range 지원(206). 없으면 200 전체
//   GET /api/videos/{id}/thumbnail     → 이미지
//
// 인증이 필요한 경로라 <video src> · <img src> 로 바로 걸 수 없다 — 그 태그들은
// Authorization 헤더를 실을 방법이 없다. 도면 이미지와 같은 방식으로(floorplan.loadImage)
// fetch 로 받아 objectURL 을 만들어 물린다.
//
// 그래서 Range 부분 요청의 이점(긴 영상 탐색)은 쓰지 못한다. 이벤트 클립은 몇 초~수십 초라
// 통째로 받아도 무리가 없고, 무엇보다 지금 계약에서 토큰을 실을 다른 방법이 없다.
// 서버가 서명된 임시 URL이나 쿠키 인증을 제공하면 그때 <video src> 로 바꿀 수 있다.

import { authedGet } from './authApi.ts'
import { REST_BASE } from './config.ts'

type VideoSummary = import('./contracts').VideoSummary

/** @returns {Promise<import('./contracts').EventDetail>} */
export function fetchEventDetail(eventId: number | string, accessToken: string | null | undefined) {
  return authedGet(`/api/events/${encodeURIComponent(eventId)}`, accessToken)
}

/**
 * 상세에 videos 가 비어 있을 때를 위한 보조 경로. 서버 버전에 따라 상세가 영상을
 * 물고 오지 않을 수 있어, 목록 API 로 한 번 더 확인한다.
 * @returns {Promise<import('./contracts').VideoSummary[]>}
 */
export async function fetchEventVideos(eventId: number | string, accessToken: string | null | undefined) {
  const rows = await authedGet(`/api/events/${encodeURIComponent(eventId)}/video`, accessToken)
  return (Array.isArray(rows) ? rows : []) as VideoSummary[]
}

// 인증 헤더를 실어 받은 뒤 objectURL 로 바꾼다. 호출부가 다 쓰면 revoke 해야 한다 —
// 안 하면 클립을 열 때마다 blob 이 쌓인다(야간에 수십 건을 넘겨보는 화면이다).
async function authedObjectUrl(path: string, accessToken: string | null | undefined, what: string) {
  const res = await fetch(`${REST_BASE}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  })
  if (!res.ok) throw new Error(`${what}을(를) 받지 못했습니다 (HTTP ${res.status})`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/** @returns {Promise<string>} objectURL — 다 쓰면 releaseUrl 로 돌려준다 */
export function loadVideoUrl(id: string, accessToken: string | null | undefined) {
  return authedObjectUrl(`/api/videos/${encodeURIComponent(id)}/stream`, accessToken, '영상')
}

/** 썸네일. 서버가 thumbnailUrl 을 주면 그 경로를, 없으면 기본 경로를 쓴다. */
export function loadThumbUrl(v: VideoSummary, accessToken: string | null | undefined) {
  const path = v.thumbnailUrl || `/api/videos/${encodeURIComponent(v.id)}/thumbnail`
  return authedObjectUrl(path, accessToken, '썸네일')
}

export function releaseUrl(url: string | null | undefined) {
  if (url) URL.revokeObjectURL(url)
}

// 클립 종류 — 서버가 문자열로 준다. 모르는 값은 그대로 보여준다(빈 칸을 만들지 않는다).
export const CLIP_LABEL: Record<string, string> = {
  EVENT: '이벤트',
  FIRE: '화재',
  OVERHEAT: '과열',
  PATROL: '순찰',
}

export const clipText = (v: VideoSummary) => {
  const kind = CLIP_LABEL[v.clipType || ''] || v.clipType || '클립'
  const dur = typeof v.durationSec === 'number' ? ` · ${v.durationSec}초` : ''
  return `${kind}${dur}`
}

// 시작 시각은 ISO 로 온다. 목록의 다른 시각 표기와 같은 모양으로 맞춘다.
export const clipTime = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', { hour12: false })
}
