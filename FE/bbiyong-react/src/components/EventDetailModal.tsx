import { useCallback, useEffect, useRef, useState } from 'react'
import { displayName, withDisplayNames } from '../live/robotName.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import { errMessage, errStatus } from '../live/errors.ts'
import { EVENT_STATUS_LABEL, LEVEL_LABEL, updateEventStatus } from '../live/events.ts'
import { TYPE_LABEL } from '../live/mappers.ts'
import {
  clipText, clipTime, fetchEventDetail, fetchEventVideos, loadThumbUrl, loadVideoUrl, releaseUrl,
} from '../live/videos.ts'
import Modal from './ui/Modal.tsx'

type Detail = import('../live/contracts.d.ts').EventDetail
type VideoSummary = import('../live/contracts.d.ts').VideoSummary

// 이벤트 상세 + 연관 블랙박스 영상 (S15P11E101-628)
//
// 야간에 쌓인 경보를 아침에 하나씩 열어 "무슨 일이었나"를 확인하고 닫는 화면이다.
// 목록의 한 줄로는 판단할 수 없어 영상이 필요하다.
export default function EventDetailModal({
  eventId, onClose, onStatusChange,
}: {
  eventId: number
  onClose: () => void
  onStatusChange?: (updated: any) => void
}) {
  const { accessToken, isAdmin, canOperate } = useAuth()

  const [detail, setDetail] = useState<Detail | null>(null)
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)

  // 재생 중인 클립과 그 objectURL. 다른 클립을 고르면 이전 것을 돌려준다.
  const [playing, setPlaying] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!accessToken) return
    setLoading(true); setErr(null)
    try {
      const d = await fetchEventDetail(eventId, accessToken)
      if (!alive.current) return
      setDetail(d)
      // 상세가 영상을 물고 오지 않는 서버 버전이 있다 — 목록 API 로 한 번 더 확인한다
      let vs = Array.isArray(d?.videos) ? d.videos : []
      if (!vs.length) {
        try { vs = await fetchEventVideos(eventId, accessToken) } catch { vs = [] }
      }
      if (alive.current) setVideos(vs)
    } catch (e) {
      if (alive.current) setErr(errStatus(e) === 404 ? '이미 삭제된 이벤트입니다.' : errMessage(e))
    } finally { if (alive.current) setLoading(false) }
  }, [eventId, accessToken])

  useEffect(() => { load() }, [load])

  // 썸네일은 목록이 들어오면 한 번씩만 받는다. 실패해도 조용히 넘긴다 —
  // 썸네일이 없다고 영상 재생까지 막을 이유가 없다.
  useEffect(() => {
    if (!videos.length || !accessToken) return undefined
    let ok = true
    const made: string[] = []
    videos.forEach((v) => {
      loadThumbUrl(v, accessToken)
        .then((url) => {
          if (!ok || !alive.current) { releaseUrl(url); return }
          made.push(url)
          setThumbs((prev) => ({ ...prev, [v.id]: url }))
        })
        .catch(() => { /* 썸네일 없음 — 자리표시자로 둔다 */ })
    })
    return () => { ok = false; made.forEach(releaseUrl) }
  }, [videos, accessToken])

  // 재생 중이던 objectURL 은 반드시 돌려준다(닫을 때·바꿀 때 모두)
  useEffect(() => () => releaseUrl(videoUrl), [videoUrl])

  const onPlay = async (v: VideoSummary) => {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      const url = await loadVideoUrl(v.id, accessToken)
      if (!alive.current) { releaseUrl(url); return }
      setVideoUrl((prev) => { releaseUrl(prev); return url })
      setPlaying(v.id)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `영상을 열지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  // 상태 전이. 서버가 받는 값은 UNRESOLVED | RESOLVED 둘뿐이다(EventLogService.ALLOWED_STATUS) —
  // Swagger 설명에는 ACKNOWLEDGED 도 적혀 있지만 검증에 없어 보내면 400 이다(S15P11E101-628).
  const onStatus = async (next: 'RESOLVED' | 'UNRESOLVED') => {
    if (busy || !detail) return
    setBusy(true); setMsg(null)
    try {
      const updated = await updateEventStatus(eventId, next, accessToken)
      if (!alive.current) return
      setDetail((prev) => (prev ? { ...prev, ...updated } : prev))
      onStatusChange?.(updated)
      setMsg({ kind: 'ok', text: `${EVENT_STATUS_LABEL[next]}(으)로 바꿨습니다.` })
    } catch (e) {
      if (alive.current) {
        setMsg({ kind: 'err', text: errStatus(e) === 404
          ? '이미 삭제된 이벤트입니다.'
          : `상태를 바꾸지 못했습니다 — ${errMessage(e)}` })
      }
    } finally { if (alive.current) setBusy(false) }
  }

  const resolved = detail?.status === 'RESOLVED'
  const num = (v: any, unit: string, digits = 1) =>
    (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : null)
  const hasMeaningfulLocation = detail?.x != null && detail?.y != null
    && (detail.x !== 0 || detail.y !== 0)

  return (
    <Modal title="이벤트 상세" onClose={onClose} width={620}>
      {loading && <p className="cfg-help">불러오는 중…</p>}
      {err && <div className="form-msg err">{err}</div>}

      {detail && (
        <>
          <div className="evd-head">
            <b className={detail.type === 'FIRE' ? 'fire' : 'heat'}>
              {TYPE_LABEL[detail.type] || detail.type}
            </b>
            {detail.level === 'CRITICAL' && <span className="tag crit">{LEVEL_LABEL.CRITICAL}</span>}
            <span className={`tag ${resolved ? 'done' : 'open'}`}>
              {EVENT_STATUS_LABEL[detail.status || 'UNRESOLVED']}
            </span>
          </div>

          <div className="cfg-note evd-meta">
            <div>{clipTime(detail.timestamp)} · {displayName(detail.robotId) || '로봇 미상'}</div>
            {detail.message && <div>{withDisplayNames(detail.message)}</div>}
            <div className="mono">
              {[
                detail.equipmentId,
                num(detail.temperature, '℃'),
                detail.threshold != null ? `임계 ${num(detail.threshold, '℃')}` : null,
                hasMeaningfulLocation ? `(${detail.x?.toFixed(2)}, ${detail.y?.toFixed(2)}) m` : null,
              ].filter(Boolean).join(' · ') || '추가 정보 없음'}
            </div>
          </div>

          {msg && <div className={`form-msg ${msg.kind}`} id="evdMsg">{msg.text}</div>}

          <h4 className="evd-h">연관 영상 <span className="k">{videos.length}건</span></h4>
          {videos.length === 0 && (
            <div className="cfg-note" id="evdNoVideo">이 이벤트에 저장된 영상이 없습니다.</div>
          )}

          {videoUrl && (
            // controls 만 준다 — 자동 재생은 야간 관제에서 소리로 놀라게 할 수 있다
            <video className="evd-video" id="evdVideo" src={videoUrl} controls preload="metadata" />
          )}

          <ul className="evd-clips" id="evdClips">
            {videos.map((v) => (
              <li key={v.id} className={playing === v.id ? 'on' : ''}>
                <button type="button" className="evd-clip" disabled={busy} onClick={() => onPlay(v)}>
                  {thumbs[v.id]
                    ? <img src={thumbs[v.id]} alt="" />
                    : <span className="evd-noimg">▶</span>}
                  <span className="evd-clipmeta">
                    <b>{clipText(v)}</b>
                    <span className="mono">{clipTime(v.startedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {canOperate && (
            <div className="form-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>닫기</button>
              <button
                type="button" id="btnEvdStatus" className="btn-primary" disabled={busy}
                onClick={() => onStatus(resolved ? 'UNRESOLVED' : 'RESOLVED')}
              >
                {busy ? '처리 중…' : (resolved ? '미해결로 되돌리기' : '해결 처리')}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
