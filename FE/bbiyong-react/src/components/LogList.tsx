import { errMessage, errStatus } from '../live/errors.ts'
import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../SimContext.ts'
import { useLive } from '../live/LiveContext.tsx'
import { useFleet } from '../live/FleetContext.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { alertToLog, eventToLog, TYPE_LABEL } from '../live/mappers.ts'
import { deleteEvent, fetchEvents, updateEventStatus, LEVEL_LABEL, EVENT_STATUS_LABEL } from '../live/events.ts'
import Modal from './ui/Modal.tsx'
import EventDetailModal from './EventDetailModal.tsx'

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

// 기간은 서버가 YYYY-MM-DD 로 받는다(startDate). '전체'는 아예 보내지 않는다.
const RANGES = [
  { key: 'ALL', label: '전체 기간', days: 0 },
  { key: 'TODAY', label: '오늘', days: 1 },
  { key: 'D7', label: '최근 7일', days: 7 },
  { key: 'D30', label: '최근 30일', days: 30 },
]

// days=1 이면 오늘 0시부터다. 로컬 시각 기준으로 만든다 —
// toISOString() 은 UTC 라 한국 시간 오전 9시 이전에는 어제 날짜가 나온다.
// 종료일에 미래 날짜를 고르게 두지 않는다 — 이벤트는 과거에만 있다
const TODAY = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

function startDateOf(days: number) {
  if (!days) return null
  const d = new Date()
  d.setDate(d.getDate() - (days - 1))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** @param {{ variant?: string, simple?: boolean }} props 리스트에 붙일 CSS 클래스 및 간소화 여부 */
export default function LogList({ variant = 'elog', simple = false }: { variant?: string, simple?: boolean }) {
  const { status } = useSim()
  const { enabled, connected, alerts, dismissAlert } = useLive()
  // 조회 대상 로봇·설비 목록은 편성 컨텍스트가 갖고 있다(S15P11E101-591)
  const { selected, robots, multi, equipments, equipmentName, reload: reloadFleet } = useFleet()
  const { accessToken, isAdmin, canOperate } = useAuth()

  const [filter, setFilter] = useState('ALL')
  // 심각도·해결 상태·기간 — 서버가 쿼리로 받아 거른다(관제센터 확장)
  const [level, setLevel] = useState('')
  const [statusF, setStatusF] = useState('')
  const [range, setRange] = useState('ALL')
  // 설비·종료일은 서버가 받는 파라미터인데 여태 화면에 없었다(S15P11E101-591)
  const [equipment, setEquipment] = useState('')
  const [endDate, setEndDate] = useState('')
  // 편성이 여럿일 때만 로봇으로 좁힐 의미가 있다. 기본은 '고른 로봇'이다.
  const [byRobot, setByRobot] = useState(true)
  const [history, setHistory] = useState<any[]>([])
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 삭제는 되돌릴 수 없다 — 무엇을 지우는지 보여주고 한 번 확인받는다(S15P11E101-516)
  const [pending, setPending] = useState<any>(null)   // 삭제 확인 대기 중인 행
  const [removing, setRemoving] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  // 해결 처리 중인 행과 그 결과 안내(S15P11E101-593)
  const [resolving, setResolving] = useState<number | null>(null)
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  // 상세로 열어 둔 이벤트. 영상은 여기서만 본다(S15P11E101-628)
  const [detailId, setDetailId] = useState<number | null>(null)

  const load = useCallback(async (nextPage: any, reset: any) => {
    if (!enabled || !accessToken) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetchEvents({
        page: nextPage,
        size: PAGE_SIZE,
        type: filter === 'ALL' ? null : (filter as import('../live/contracts.d.ts').EventType),
        level: (level || null) as import('../live/contracts.d.ts').EventLevel | null,
        status: (statusF || null) as import('../live/contracts.d.ts').EventStatus | null,
        startDate: startDateOf(RANGES.find((r) => r.key === range)?.days ?? 0),
        endDate: endDate || null,
        robotId: multi && byRobot ? selected : null,
        equipmentId: equipment || null,
      }, accessToken)
      const rows = (res?.content || []).map(eventToLog)
      setHistory((prev) => (reset ? rows : [...prev, ...rows]))
      setPage(nextPage)
      setMore(nextPage + 1 < (res?.totalPages ?? 0))
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setLoading(false)
    }
  }, [enabled, accessToken, filter, level, statusF, range, endDate, equipment, multi, byRobot, selected])

  // 필터가 바뀌면 처음부터 다시 받는다
  useEffect(() => {
    if (!enabled) { setHistory([]); setMore(false); setError(null); return }
    load(0, true)
  }, [enabled, filter, level, statusF, range, endDate, equipment, byRobot, selected, load])

  if (!enabled) {
    // 시뮬 모드 — 기존 시뮬 로그를 그대로 보여준다(필터·이력 없음)
    return (
      <ul className={variant}>
        {status.logs.map((log: any) => (
          <li key={log.id} className={log.kind}>
            <span className="t mono">{log.time}</span>
            <b>{log.msg}</b>
          </li>
        ))}
      </ul>
    )
  }

  // 실시간 수신분은 서버 쿼리를 거치지 않으므로 같은 조건을 화면에서 적용한다.
  // 기간 필터는 걸지 않는다 — 방금 들어온 경보는 어느 기간을 골랐든 지금 일어난 일이다.
  const liveRows = alerts.map(alertToLog).reverse()
    .filter((l: any) => filter === 'ALL' || l.type === filter)
    .filter((l: any) => !level || l.level === level)
    .filter((l: any) => !statusF || l.status === statusF)
    .filter((l: any) => !(multi && byRobot) || l.robotId === selected)
    .filter((l: any) => !equipment || l.equipmentId === equipment)
  // 실시간 수신 직후에는 liveRows로 보이고, 같은 eventId가 이력 조회에 잡히면
  // 이력 행으로 교체한다. 같은 이벤트가 두 줄로 보이지 않게 한다.
  const historyEventIds = new Set(history.map((l) => l.eventId).filter((id) => id != null))
  const rows = [
    ...liveRows.filter((l: any) => l.eventId == null || !historyEventIds.has(l.eventId)),
    ...history,
  ]

  // 해결 처리 — 되돌릴 수 있으므로(같은 API 로 UNRESOLVED 로 되돌린다) 확인을 받지 않는다.
  // 삭제와 달리 복구되는 동작이라 확인 모달을 두면 야간 경보를 한 건씩 닫는 일이 번거로워진다.
  const onResolve = async (log: any, next: 'RESOLVED' | 'UNRESOLVED') => {
    if (resolving != null) return
    setResolving(log.eventId); setResolveErr(null)
    try {
      const updated = await updateEventStatus(log.eventId, next, accessToken)
      // 서버가 갱신된 EventLog 를 돌려준다 — 목록을 다시 받지 않고 그 행만 바꾼다.
      // 전체 재조회는 스크롤 위치와 '더 보기'로 쌓아 둔 페이지를 날린다.
      //
      // 조건이 '미해결'인 상태에서 해결하면 이 행은 더 이상 조건에 맞지 않지만 남겨 둔다 —
      // 즉시 사라지면 방금 무엇을 눌렀는지 확인할 수 없다. 다음 조회 때 자연히 빠진다.
      setHistory((prev) => {
        const nextLog = { ...eventToLog(updated), _touched: true }
        const found = prev.some((l) => l.eventId === log.eventId)
        return found
          ? prev.map((l) => (l.eventId === log.eventId ? { ...l, ...nextLog } : l))
          : [nextLog, ...prev]
      })
      // 요약 띠의 미해결 건수도 같이 바뀌어야 한다. 30초 주기를 기다리면 두 수치가 어긋나 보인다.
      reloadFleet()
    } catch (e) {
      // 404 = 다른 사람이 먼저 지웠다 · 400 = 서버가 받지 않는 값이다. 구분해 알린다.
      const st = errStatus(e)
      setResolveErr(st === 404
        ? '이미 삭제된 이벤트입니다. 목록을 새로 고치세요.'
        : (st === 400 ? `서버가 받지 않는 상태 값입니다 — ${errMessage(e)}` : errMessage(e)))
    } finally { setResolving(null) }
  }

  // 서버에서 지운다. 실시간 행도 저장된 eventId를 받으므로 같은 API로 처리한다.
  const onDelete = async () => {
    if (!pending || removing) return
    setRemoving(true); setDelErr(null)
    try {
      await deleteEvent(pending.eventId, accessToken)
      setHistory((prev) => prev.filter((l) => l.eventId !== pending.eventId))
      if (pending.live) dismissAlert(pending.id)
      setPending(null)
    } catch (e) {
      setDelErr(errMessage(e))
    } finally { setRemoving(false) }
  }

  return (
    <>
      {!simple && (
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
          {/* 심각도·상태·기간은 서버가 걸러 준다 — 화면에서 자르면 '더 보기'가 어긋난다 */}
          <div className="logfilter2">
            <select aria-label="심각도" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">심각도 전체</option>
              <option value="CRITICAL">{LEVEL_LABEL.CRITICAL}</option>
              <option value="WARNING">{LEVEL_LABEL.WARNING}</option>
            </select>
            <select aria-label="해결 상태" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">상태 전체</option>
              <option value="UNRESOLVED">{EVENT_STATUS_LABEL.UNRESOLVED}</option>
              <option value="RESOLVED">{EVENT_STATUS_LABEL.RESOLVED}</option>
            </select>
            <select aria-label="조회 기간" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          <div className="logfilter2">
            {/* 이름으로 고르되 서버에는 equipmentId 를 보낸다 */}
            <select aria-label="설비" value={equipment} onChange={(e) => setEquipment(e.target.value)}>
              <option value="">설비 전체</option>
              {equipments.map((eq) => {
                const eid = eq.equipmentId
                return <option key={eid} value={eid}>{equipmentName(eid)}</option>
              })}
            </select>
            <input type="date" aria-label="종료일" value={endDate} max={TODAY}
              onChange={(e) => setEndDate(e.target.value)} />
          </div>
          {multi && (
            <label className="logfilter-rb">
              <input type="checkbox" checked={byRobot} onChange={(e) => setByRobot(e.target.checked)} />
              {robots.find((r) => r.robotId === selected)?.name || selected} 것만 보기
            </label>
          )}
        </>
      )}
      <ul className={variant}>
        {rows.length === 0 && (
          <li className="ok">
            <b>{loading ? '이력 불러오는 중…' : (connected ? '경보 없음 — 수신 대기 중' : '실서버 연결 중…')}</b>
          </li>
        )}
        {rows.map((log) => (
          <li key={log.id} className={log.kind}>
            <span className="t mono">{simple ? log.time : (log.date ? `${log.date} ${log.time}` : log.time)}</span>
            {simple ? (
              <b>{log.msg}</b>
            ) : (
              <>
                {log.eventId != null
                  ? (
                    <button type="button" className="logopen" title="상세와 영상 보기"
                      onClick={() => setDetailId(log.eventId)}>
                      {log.msg}
                    </button>
                  )
                  : <b>{log.msg}</b>}
                {log.live && <span className="tag live">실시간</span>}
                {log.level === 'CRITICAL' && <span className="tag crit">{LEVEL_LABEL.CRITICAL}</span>}
                {log.status === 'UNRESOLVED' && !log.live && <span className="tag open">{EVENT_STATUS_LABEL.UNRESOLVED}</span>}
                {log.status === 'RESOLVED' && <span className="tag done">{EVENT_STATUS_LABEL.RESOLVED}</span>}
                {canOperate && log.eventId != null && (
                  <button type="button" className="logfix"
                    title={log.status === 'RESOLVED' ? '미해결로 되돌리기' : '이 이벤트를 해결 처리'}
                    aria-label={`${log.status === 'RESOLVED' ? '미해결로 되돌리기' : '해결 처리'} — ${log.msg}`}
                    disabled={resolving === log.eventId}
                    onClick={() => onResolve(log, log.status === 'RESOLVED' ? 'UNRESOLVED' : 'RESOLVED')}>
                    {resolving === log.eventId ? '…' : (log.status === 'RESOLVED' ? '되돌리기' : '해결')}
                  </button>
                )}
                {canOperate && log.eventId != null && (
                  <button type="button" className="logdel" title="이 이벤트를 서버에서 삭제"
                    aria-label={`이벤트 삭제 — ${log.msg}`} onClick={() => { setDelErr(null); setPending(log) }}>
                    삭제
                  </button>
                )}
                {canOperate && log.live && (
                  <button type="button" className="logdel" title="화면에서 닫기 (서버 기록은 남습니다)"
                    aria-label={`경보 닫기 — ${log.msg}`} onClick={() => dismissAlert(log.id)}>
                    닫기
                  </button>
                )}
              </>
            )}
          </li>
        ))}
        {resolveErr && <li className="heat"><b>해결 처리 실패 — {resolveErr}</b></li>}
        {error && <li className="heat"><b>이력 조회 실패 — {error}</b></li>}
        {more && (
          <li className="loadmore">
            <button type="button" onClick={() => load(page + 1, false)} disabled={loading}>
              {loading ? '불러오는 중…' : '이전 기록 더 보기'}
            </button>
          </li>
        )}
      </ul>

      {detailId != null && (
        <EventDetailModal
          eventId={detailId}
          onClose={() => setDetailId(null)}
          // 상세에서 상태를 바꾸면 목록의 그 행도 함께 맞춘다 — 두 곳이 어긋나 보이면 안 된다
          onStatusChange={(updated: any) => {
            setHistory((prev) => {
              const nextLog = eventToLog(updated)
              const found = prev.some((l) => l.eventId === updated?.eventId)
              return found
                ? prev.map((l) => (l.eventId === updated?.eventId ? { ...l, ...nextLog } : l))
                : [nextLog, ...prev]
            })
          }}
        />
      )}

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
