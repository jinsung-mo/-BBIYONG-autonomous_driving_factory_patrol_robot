// @ts-check
import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../SimContext.js'
import { useLive } from '../live/LiveContext.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { alertToLog, eventToLog, TYPE_LABEL } from '../live/mappers.js'
import { authedGet } from '../live/authApi.js'
import { deleteEvent } from '../live/events.js'
import Modal from './ui/Modal.jsx'

// 이벤트 로그 (순찰 로봇 관제의 .elog).
//
// live 모드에서는 실시간 수신분(/topic/alerts)과 과거 이력(GET /api/events)을 함께 보여준다.
// 실시간 경보는 one-shot 이라 화면을 새로 열면 사라지므로, 이력 조회가 있어야
// "아까 무슨 일이 있었나"를 볼 수 있다(S15P11E101-464).
const FILTERS = [
  { key: 'ALL', label: '전체' },
  { key: 'FIRE', label: '화재' },
  { key: 'OVERHEAT', label: '과열' },
  { key: 'SYSTEM', label: '시스템' },
]
const PAGE_SIZE = 20

/** @param {{ variant?: string }} props 리스트에 붙일 CSS 클래스 */
export default function LogList({ variant = 'elog' }) {
  const { status } = useSim()
  const { enabled, connected, alerts, dismissAlert } = useLive()
  const { accessToken, isAdmin } = useAuth()

  const [filter, setFilter] = useState('ALL')
  const [history, setHistory] = useState([])
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // 삭제는 되돌릴 수 없다 — 무엇을 지우는지 보여주고 한 번 확인받는다(S15P11E101-516)
  const [pending, setPending] = useState(null)   // 삭제 확인 대기 중인 행
  const [removing, setRemoving] = useState(false)
  const [delErr, setDelErr] = useState(null)

  const load = useCallback(async (nextPage, reset) => {
    if (!enabled || !accessToken) return
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams({ page: String(nextPage), size: String(PAGE_SIZE) })
      if (filter !== 'ALL') q.set('type', filter)
      const res = await authedGet(`/api/events?${q}`, accessToken)
      const rows = (res?.content || []).map(eventToLog)
      setHistory((prev) => (reset ? rows : [...prev, ...rows]))
      setPage(nextPage)
      setMore(nextPage + 1 < (res?.totalPages ?? 0))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [enabled, accessToken, filter])

  // 필터가 바뀌면 처음부터 다시 받는다
  useEffect(() => {
    if (!enabled) { setHistory([]); setMore(false); setError(null); return }
    load(0, true)
  }, [enabled, filter, load])

  if (!enabled) {
    // 시뮬 모드 — 기존 시뮬 로그를 그대로 보여준다(필터·이력 없음)
    return (
      <ul className={variant}>
        {status.logs.map((log) => (
          <li key={log.id} className={log.kind}>
            <span className="t mono">{log.time}</span>
            <b>{log.msg}</b>
          </li>
        ))}
      </ul>
    )
  }

  const liveRows = alerts.map(alertToLog).reverse()
    .filter((l) => filter === 'ALL' || l.type === filter)
  const rows = [...liveRows, ...history]

  // 서버에서 지운다. 실시간 수신분은 eventId 가 없어(AlertMessage 에 필드가 없다)
  // 여기 오지 않는다 — 그쪽은 화면에서 닫기만 한다.
  const onDelete = async () => {
    if (!pending || removing) return
    setRemoving(true); setDelErr(null)
    try {
      await deleteEvent(pending.eventId, accessToken)
      setHistory((prev) => prev.filter((l) => l.eventId !== pending.eventId))
      setPending(null)
    } catch (e) {
      setDelErr(e.message)
    } finally { setRemoving(false) }
  }

  return (
    <>
      <div className="logfilter" role="group" aria-label="이벤트 종류 필터">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'on' : ''}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className={variant}>
        {rows.length === 0 && (
          <li className="ok">
            <b>{loading ? '이력 불러오는 중…' : (connected ? '경보 없음 — 수신 대기 중' : '실서버 연결 중…')}</b>
          </li>
        )}
        {rows.map((log) => (
          <li key={log.id} className={log.kind}>
            <span className="t mono">{log.date ? `${log.date} ` : ''}{log.time}</span>
            <b>{log.msg}</b>
            {log.live && <span className="tag">실시간</span>}
            {/* 이력 행은 서버에서 삭제, 실시간 행은 화면에서만 닫는다(서버 id 가 없다) */}
            {isAdmin && log.eventId != null && (
              <button type="button" className="logdel" title="이 이벤트를 서버에서 삭제"
                aria-label={`이벤트 삭제 — ${log.msg}`} onClick={() => { setDelErr(null); setPending(log) }}>
                삭제
              </button>
            )}
            {isAdmin && log.live && (
              <button type="button" className="logdel" title="화면에서 닫기 (서버 기록은 남습니다)"
                aria-label={`경보 닫기 — ${log.msg}`} onClick={() => dismissAlert(log.id)}>
                닫기
              </button>
            )}
          </li>
        ))}
        {error && <li className="heat"><b>이력 조회 실패 — {error}</b></li>}
        {more && (
          <li className="loadmore">
            <button type="button" onClick={() => load(page + 1, false)} disabled={loading}>
              {loading ? '불러오는 중…' : '이전 기록 더 보기'}
            </button>
          </li>
        )}
      </ul>

      {pending && (
        <Modal title="이벤트를 삭제할까요?" onClose={() => setPending(null)} width={400}>
          <p className="cfg-help" style={{ marginBottom: 10 }}>
            아래 기록을 <b>서버에서 영구 삭제</b>합니다. 되돌릴 수 없습니다.
          </p>
          <div className="cfg-note" style={{ marginTop: 0, marginBottom: 12 }}>
            <b className="mono">{pending.date ? `${pending.date} ` : ''}{pending.time}</b> · {pending.msg}
          </div>
          {delErr && <div className="form-msg err">삭제하지 못했습니다 — {delErr}</div>}
          <div className="gotor">
            <button type="button" className="dbtn" onClick={() => setPending(null)}>취소</button>
            <button type="button" id="btnDeleteEvent" className="dbtn stop" onClick={onDelete} disabled={removing}>
              {removing ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

export { TYPE_LABEL }
