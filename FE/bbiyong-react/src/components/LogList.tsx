import { errMessage, errStatus } from '../live/errors.ts'
import { useCallback, useEffect, useState } from 'react'
import { useSim } from '../SimContext.ts'
import { useLive } from '../live/LiveContext.tsx'
import { useFleet } from '../live/FleetContext.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { alertToLog, eventToLog } from '../live/mappers.ts'
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

// 종료일에 미래 날짜를 고르게 두지 않는다 — 이벤트는 과거에만 있다.
// 로컬 시각 기준으로 만든다(toISOString 은 UTC 라 오전 9시 이전엔 어제가 나온다).
const TODAY = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

const DATE_INPUT_STYLE = { padding: '9px 10px', borderRadius: '8px', border: '1px solid #D6D9E3', background: '#fff', color: '#232733', fontFamily: 'inherit', fontSize: '12.5px' } as const

// 카드 우측의 "N일 전" — 정확한 타임스탬프(ts)가 있을 때만 계산한다. 없으면 렌더 쪽에서 '—'.
function relativeDay(ts: string | null | undefined): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return '오늘'
  if (days === 1) return '어제'
  return `${days}일 전`
}

// 이벤트 종류별 카드 아이콘 타일 — 색은 기존 c-fire/c-heat/c-ok 팔레트를 그대로 쓴다.
// 이벤트 종류 아이콘 (S15P11E101-814) [사용자 지침 2026-08-09].
//
// 종전에는 글자였다 — 화재 ▲, 과열 ◉, 그 외 ●. 도형만으로는 무엇인지 읽히지 않아
// 색으로만 구분되는 셈이었고, 색은 적록색맹에게 근거가 되지 못한다.
//
// 화재·과열은 형태가 뜻을 갖는 자리라 SVG 로 그린다(불꽃 / 온도계). 글꼴에 있는
// 기호를 쓰면 환경마다 모양과 굵기가 달라지고, 이모지는 이 코드베이스가 쓰지 않는다.
//
// 🔴 그 외(초록)는 새로 만들지 않고 **상단 KPI 배지의 체크(✓)를 그대로 쓴다**
// (KpiRow.tsx 의 SIGN.ok). 같은 화면에서 "정상"을 뜻하는 기호가 둘이면 둘 중 하나는
// 다른 뜻이라고 읽힌다 — 기호는 화면 전체에서 하나여야 한다.
const OK_SIGN = '✓'   // KpiRow.tsx SIGN.ok 와 같은 문자. 바꾸려면 두 곳을 함께 본다.

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'fire') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
        fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round">
        {/* 불꽃 — 바깥 윤곽과 안쪽 심지 두 겹으로 그려야 작은 크기에서도 불로 읽힌다 */}
        <path d="M12 2.7c.9 2.6 2.6 3.8 4 5.6a7.5 7.5 0 1 1-11.6 4.4C4.9 9 7.7 7.4 9 4.6c.9 1.7 1.4 2.6 2.2 3.3.4-1.9.5-3.6.8-5.2Z" />
        <path d="M12 21a3.6 3.6 0 0 1-1.6-6.9c.6 1 1.2 1.5 2 2 .3-.9.4-1.7.5-2.6 1.3 1.1 2.7 2.6 2.7 4.1A3.6 3.6 0 0 1 12 21Z" />
      </svg>
    )
  }
  if (kind === 'heat') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
        fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round">
        {/* 온도계 — 구근 + 기둥 + 눈금. 눈금이 있어야 '온도'로 읽힌다(원만 있으면 점) */}
        <path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z" />
        <path d="M12 16.6v-5" />
        <path d="M16.8 7.2h2.6M16.8 10.4h1.6" />
      </svg>
    )
  }
  // 정상·해결 등 — 상단 KPI 배지와 같은 체크
  return <span aria-hidden="true">{OK_SIGN}</span>
}

/** @param {{ variant?: string, simple?: boolean }} props 리스트에 붙일 CSS 클래스 및 간소화 여부 */
export default function LogList({ variant = 'elog', simple = false }: { variant?: string, simple?: boolean }) {
  const { status } = useSim()
  const { enabled, connected, alerts, dismissAlert } = useLive()
  // 조회 대상 로봇 목록은 편성 컨텍스트가 갖고 있다(S15P11E101-591)
  const { selected, robots, multi, reload: reloadFleet } = useFleet()
  const { accessToken, isAdmin, canOperate } = useAuth()

  const [filter, setFilter] = useState('ALL')
  // 심각도·해결 상태·기간 — 서버가 쿼리로 받아 거른다(관제센터 확장)
  const [level, setLevel] = useState('')
  const [statusF, setStatusF] = useState('')
  // 조회 구간 — 시작일~종료일(YYYY-MM-DD)을 직접 고른다(S15P11E101 콘솔 정리).
  // 예전엔 시작=프리셋 / 종료=자유 입력이라 '오늘' + 어제 종료 같은 모순 조회가 가능했다.
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  // 시작일이 종료일보다 늦으면 서버 조건이 모순돼 항상 빈 결과가 된다 — 조회를 막고 안내한다.
  const rangeInvalid = !!(startDate && endDate && startDate > endDate)
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
  // 선택 삭제(S15P11E101-884) — 체크한 행(eventId)들을 한 번의 확인으로 지운다.
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  // 해결 처리 중인 행과 그 결과 안내(S15P11E101-593)
  const [resolving, setResolving] = useState<number | null>(null)
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  // 상세로 열어 둔 이벤트. 영상은 여기서만 본다(S15P11E101-628)
  const [detailId, setDetailId] = useState<number | null>(null)
  // 카드 목록 정렬 — 서버는 정렬 파라미터를 받지 않으므로(events.ts) 이미 받아 온
  // 목록(최신순으로 쌓인다)을 화면에서만 뒤집는다. 데이터를 다시 받지 않는다.
  //
  // 🔴 그래서 **뒤에 안 받아 온 페이지가 남아 있으면 '오래된순'을 고를 수 없게 막는다.**
  // 20건만 받은 상태에서 뒤집으면 "전체에서 가장 오래된 것"이 아니라 "받아 온 20건 중
  // 가장 오래된 것"이 맨 위에 온다. 조작자는 그걸 구별할 방법이 없으므로 그대로 두면
  // 화면이 거짓말을 한다. 서버가 정렬 파라미터를 주기 시작하면 이 제약은 없앨 수 있다.
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  // 서버가 알려 주는 **전체** 건수. 화면에 쌓인 개수(rows.length)와 다르다 —
  // 500건 중 20건만 받은 상태에서 "20건"이라고 쓰면 전체가 20건인 줄 안다.
  // 모르면 null 로 두고 '—' 를 쓴다(없는 수치를 지어내지 않는다).
  const [totalCount, setTotalCount] = useState<number | null>(null)

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
        startDate: startDate || null,
        endDate: endDate || null,
        robotId: multi && byRobot ? selected : null,
        equipmentId: null,
      }, accessToken)
      const rows = (res?.content || []).map(eventToLog)
      setHistory((prev) => (reset ? rows : [...prev, ...rows]))
      setPage(nextPage)
      setMore(nextPage + 1 < (res?.totalPages ?? 0))
      setTotalCount(typeof res?.totalElements === 'number' ? res.totalElements : null)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setLoading(false)
    }
  }, [enabled, accessToken, filter, level, statusF, startDate, endDate, multi, byRobot, selected])

  // 필터가 바뀌면 처음부터 다시 받는다. 구간이 모순이면 조회하지 않는다.
  // 선택도 비운다 — 새 목록에 없는 id 가 선택으로 남으면 유령을 지우려 든다.
  useEffect(() => {
    setChecked(new Set())
    if (!enabled) { setHistory([]); setMore(false); setError(null); return }
    if (rangeInvalid) { setHistory([]); setMore(false); setError('시작일이 종료일보다 늦습니다.'); return }
    load(0, true)
  }, [enabled, filter, level, statusF, startDate, endDate, byRobot, selected, load, rangeInvalid])

  if (!enabled) {
    // 시뮬 모드 — 기존 시뮬 로그를 그대로 보여준다(필터·이력 없음)
    return (
      <ul className={variant}>
        {status.logs.map((log: any) => (
          <li key={log.id} className={log.kind}>
            {/* 시뮬 로그도 실서버와 같은 행 구성을 쓴다(S15P11E101-797) —
                한쪽만 점이 없으면 같은 화면이 두 모양으로 보인다. */}
            <i className="logdot" />
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
  // 실시간 수신 직후에는 liveRows로 보이고, 같은 eventId가 이력 조회에 잡히면
  // 이력 행으로 교체한다. 같은 이벤트가 두 줄로 보이지 않게 한다.
  const historyEventIds = new Set(history.map((l) => l.eventId).filter((id) => id != null))
  const rows = [
    ...liveRows.filter((l: any) => l.eventId == null || !historyEventIds.has(l.eventId)),
    ...history,
  ]
  // 화면에서만 순서를 뒤집는다 — rows 자체(최신순으로 쌓인다)는 그대로 두고 보여줄 때만 바꾼다.
  // 안 받아 온 페이지가 남아 있으면(more) 뒤집어도 "전체에서 오래된 것"이 아니므로 뒤집지 않는다.
  const canSortAsc = !more
  const sortedRows = (sortOrder === 'asc' && canSortAsc) ? [...rows].reverse() : rows

  // 해결 처리 — 되돌릴 수 있으므로(같은 API 로 UNRESOLVED 로 되돌린다) 확인을 받지 않는다.
  // 삭제와 달리 복구되는 동작이라 확인 모달을 두면 야간 경보를 한 건씩 닫는 일이 번거로워진다.
  const onResolve = async (log: any, next: 'RESOLVED' | 'UNRESOLVED') => {
    if (resolving != null) return
    setResolving(log.eventId); setResolveErr(null)
    try {
      const updated = await updateEventStatus(log.eventId, next, accessToken)
      // 서버가 갱신된 EventLog 를 돌려준다 — 목록을 다시 받지 않고 화면에서만 반영한다.
      // 전체 재조회는 스크롤 위치와 '더 보기'로 쌓아 둔 페이지를 날린다.
      //
      // 해결(RESOLVED)한 행은 목록에서 바로 내린다 [사용자 지침 2026-08-09] —
      // 처리한 경보가 계속 쌓여 있으면 남은 일이 얼마나 되는지 읽기 어렵다.
      // 서버 기록은 남으므로 '해결됨' 필터로 조회하면 다시 볼 수 있다.
      // 되돌리기(UNRESOLVED)는 그 반대라 행을 남기고 상태만 바꾼다.
      if (next === 'RESOLVED') {
        setHistory((prev) => prev.filter((l) => l.eventId !== log.eventId))
        if (log.live) dismissAlert(log.id)
      } else {
        setHistory((prev) => {
          const nextLog = { ...eventToLog(updated), _touched: true }
          const found = prev.some((l) => l.eventId === log.eventId)
          return found
            ? prev.map((l) => (l.eventId === log.eventId ? { ...l, ...nextLog } : l))
            : [nextLog, ...prev]
        })
      }
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

  // 선택 일괄 삭제(S15P11E101-884). 서버에 일괄 API 가 없어 한 건씩 지운다 —
  // 도중에 실패하면 지운 것까지만 화면에서 내리고, 남은 선택은 그대로 두고 알린다.
  const onBulkDelete = async () => {
    if (removing || checked.size === 0) return
    setRemoving(true); setDelErr(null)
    const done: number[] = []
    try {
      for (const id of checked) {
        await deleteEvent(id, accessToken)
        done.push(id)
      }
      setBulkOpen(false)
      setChecked(new Set())
    } catch (e) {
      setDelErr(errMessage(e))
      setChecked((prev) => { const n = new Set(prev); for (const id of done) n.delete(id); return n })
    } finally {
      if (done.length) {
        const gone = new Set(done)
        setHistory((prev) => prev.filter((l) => !gone.has(l.eventId)))
        // 같은 이벤트의 실시간 행도 닫는다 — 남겨 두면 지웠는데 한 줄이 되살아난 것처럼 보인다
        for (const l of liveRows) if (l.eventId != null && gone.has(l.eventId)) dismissAlert(l.id)
        reloadFleet()
      }
      setRemoving(false)
    }
  }

  // 선택 대상은 서버에 저장된 행(eventId 있는 행)뿐이다 — 저장 전 실시간 행은 지울 것이 없다.
  const selectable = sortedRows.filter((l) => l.eventId != null)
  const allChecked = selectable.length > 0 && selectable.every((l) => checked.has(l.eventId))
  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(selectable.map((l) => l.eventId as number)))
  }
  const toggleOne = (id: number) => {
    setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  return (
    <>
      {!simple && (
        <div className="event-page-grid">
          <div className="event-page-col">
            <div className="card-v3">
              <b style={{ fontSize: '14px' }}>요약</b>
              <div className="kv" style={{ borderTop: 0, paddingTop: '10px' }}>
                조건 검색 결과 <b className="mono" style={{ color: '#232733' }}>{rows.length}</b>
              </div>
              <div className="kv">미해결 <b className="mono" style={{ color: '#B4655C' }}>
                {rows.filter(r => r.status === 'UNRESOLVED').length}
              </b></div>
            </div>

            <div className="card-v3">
              <b style={{ fontSize: '14px' }}>필터</b>
              <div style={{ marginTop: '11px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <select style={{ padding: '9px 10px', borderRadius: '8px', border: '1px solid #D6D9E3', background: '#fff', color: '#232733', fontFamily: 'inherit', fontSize: '12.5px' }}
                  value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {FILTERS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
                <select style={{ padding: '9px 10px', borderRadius: '8px', border: '1px solid #D6D9E3', background: '#fff', color: '#232733', fontFamily: 'inherit', fontSize: '12.5px' }}
                  aria-label="심각도" value={level} onChange={(e) => setLevel(e.target.value)}>
                  <option value="">심각도 전체</option>
                  <option value="CRITICAL">{LEVEL_LABEL.CRITICAL}</option>
                  <option value="WARNING">{LEVEL_LABEL.WARNING}</option>
                </select>
                <select style={{ padding: '9px 10px', borderRadius: '8px', border: '1px solid #D6D9E3', background: '#fff', color: '#232733', fontFamily: 'inherit', fontSize: '12.5px' }}
                  aria-label="해결 상태" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
                  <option value="">상태 전체</option>
                  <option value="UNRESOLVED">{EVENT_STATUS_LABEL.UNRESOLVED}</option>
                  <option value="RESOLVED">{EVENT_STATUS_LABEL.RESOLVED}</option>
                </select>
                {/* 조회 구간 — 시작일~종료일(연-월-일)을 직접 고른다. 비워 두면 그쪽 경계는 없다. */}
                <label style={{ fontSize: '11.5px', color: '#5A6072' }}>시작일
                  <input style={{ ...DATE_INPUT_STYLE, width: '100%', marginTop: '3px' }}
                    type="date" aria-label="시작일" value={startDate} max={endDate || TODAY}
                    onChange={(e) => setStartDate(e.target.value)} />
                </label>
                <label style={{ fontSize: '11.5px', color: '#5A6072' }}>종료일
                  <input style={{ ...DATE_INPUT_STYLE, width: '100%', marginTop: '3px' }}
                    type="date" aria-label="종료일" value={endDate} min={startDate || undefined} max={TODAY}
                    onChange={(e) => setEndDate(e.target.value)} />
                </label>
                {rangeInvalid && <div className="form-msg err" style={{ fontSize: '11.5px' }}>시작일이 종료일보다 늦습니다.</div>}
                {multi && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: '#5A6072', marginTop: '2px' }}>
                    <input type="checkbox" checked={byRobot} onChange={(e) => setByRobot(e.target.checked)} />
                    {robots.find((r) => r.robotId === selected)?.name || selected} 것만 보기
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* 🔴 바깥 껍질은 배경 없이 둔다(elog-shell) [사용자 지적 2026-08-09].
              `.card-v3` 는 흰 배경 + 그림자인데 개별 이벤트도 흰 카드라, 흰 위에 흰이
              얹혀 카드 경계가 사라졌다. 목록을 카드로 만든 이유 자체가 무효가 된다.
              배경은 한 겹만 갖는다 — 여기서는 개별 행이 그 한 겹이다. */}
          <div className="card-v3 elog-shell">
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '9px' }}>
              <b style={{ fontSize: '17px' }}>전체 이벤트</b>
              {/* 'EVENT LOG · ALL' 영문 라벨과 '전체 기간' 표기는 제거했다(사용자 요청 2026-08-10).
                  기간을 실제로 좁혀 조회 중일 때만 그 구간을 우측에 보여 준다. */}
              {(startDate || endDate) && (
                <span style={{ marginLeft: 'auto', fontSize: '13px', color: '#A8ADBC' }}>
                  {`${startDate || '처음'} ~ ${endDate || '오늘'}`}
                </span>
              )}
            </div>

            {/* 목록 위 헤더 — 좌: 총 건수, 우: 정렬. 목록 자체와 별도 행으로 둔다(S15P11E101-814). */}
            <div className="elog-toolbar">
              {/* 총 건수는 서버가 준 전체(totalElements)를 쓴다. 화면에 쌓인 개수가 아니다 —
                  더 받을 게 남아 있으면 "N건 중 M건 표시"로 둘을 구별해 보여 준다. */}
              <span className="elog-count">
                {totalCount == null
                  ? <><b className="mono">{rows.length}</b>건</>
                  : (more
                    ? <><b className="mono">{totalCount}</b>건 중 <b className="mono">{rows.length}</b>건 표시</>
                    : <><b className="mono">{totalCount}</b>건</>)}
              </span>
              {/* 선택 삭제(S15P11E101-884) — 화면에 보이는 저장 행 전체 선택 + 일괄 삭제.
                  삭제 권한이 있는 사람에게만 보인다(개별 삭제 버튼과 같은 조건). */}
              {canOperate && (
                <label className="elog-selall" title="화면에 보이는 기록 전체 선택">
                  <input type="checkbox" checked={allChecked} disabled={selectable.length === 0}
                    onChange={toggleAll} aria-label="이벤트 전체 선택" />
                  전체 선택
                </label>
              )}
              {canOperate && checked.size > 0 && (
                <button type="button" className="elog-bulkdel"
                  onClick={() => { setDelErr(null); setBulkOpen(true) }}>
                  선택 삭제 ({checked.size})
                </button>
              )}
              <select
                className="elog-sort" aria-label="정렬 순서" value={canSortAsc ? sortOrder : 'desc'}
                disabled={!canSortAsc}
                title={canSortAsc ? undefined : '이전 기록을 모두 불러온 뒤에 바꿀 수 있습니다'}
                onChange={(e) => setSortOrder(e.target.value as 'desc' | 'asc')}>
                <option value="desc">최신순</option>
                <option value="asc">오래된순</option>
              </select>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <ul className={variant} style={{ listStyle: 'none', padding: 0 }}>
                {sortedRows.length === 0 && (
                  <li className="logrow">
                    <b>{loading ? '이력 불러오는 중…' : (connected ? '경보 없음 — 수신 대기 중' : '실서버 연결 중…')}</b>
                  </li>
                )}
                {sortedRows.map((log) => {
                  // 🔴 아이콘 타일은 **종류가 아니라 처리 상태**를 말한다 [사용자 지적 2026-08-09].
                  // 종전에는 kind(=type) 하나로만 골라서, 해결 처리한 화재가 '해결' 뱃지를 달고도
                  // 빨간 불꽃 타일 그대로 남았다. 목록을 훑는 조작자는 뱃지 글자보다 색 타일을
                  // 먼저 보므로, 이미 닫은 경보가 계속 미처리로 읽혔다.
                  //
                  // 해결된 행은 상단 KPI 배지와 같은 초록 체크(c-ok · OK_SIGN)로 바꾼다 —
                  // SYSTEM 이벤트가 이미 쓰고 있는 그 타일이다. 새 색·새 기호를 만들지 않는다.
                  //
                  // 제목 글자색(tKey)은 종류를 그대로 따른다 — 무슨 일이었는지(화재/과열)는
                  // 해결 여부와 별개로 남아야 한다. '긴급' 뱃지도 그대로 붙는다.
                  const iconKind = log.status === 'RESOLVED' ? 'ok' : log.kind
                  const kindKey = iconKind === 'fire' || iconKind === 'heat' || iconKind === 'ok' ? iconKind : 'sub'
                  const tKey = log.kind === 'fire' || log.kind === 'heat' || log.kind === 'ok' ? log.kind : 'ink'
                  const rel = relativeDay(log.ts)
                  return (
                    <li key={log.id} className={`logrow elog-card ${log.kind} ${detailId === log.eventId ? 'sel' : ''}`}>
                      {canOperate && log.eventId != null && (
                        <input type="checkbox" className="elog-pick" checked={checked.has(log.eventId)}
                          onChange={() => toggleOne(log.eventId)} aria-label={`선택 — ${log.msg}`} />
                      )}
                      <i className={`elog-card-icon c-${kindKey}`} aria-hidden="true"><KindIcon kind={iconKind} /></i>
                      <div className="elog-card-body">
                        <div className="elog-card-title-row">
                          {log.eventId != null
                            ? (
                              <button type="button" className={`logopen elog-card-title t-${tKey}`} title="상세와 영상 보기"
                                onClick={() => setDetailId(log.eventId)}>
                                {log.msg}
                              </button>
                            )
                            : <span className={`elog-card-title t-${tKey}`}>{log.msg}</span>}
                          {log.live && <span className="tag live">실시간</span>}
                          {log.level === 'CRITICAL' && <span className="tag crit">{LEVEL_LABEL.CRITICAL}</span>}
                          {log.status === 'UNRESOLVED' && !log.live && <span className="tag open">{EVENT_STATUS_LABEL.UNRESOLVED}</span>}
                          {log.status === 'RESOLVED' && <span className="tag done">{EVENT_STATUS_LABEL.RESOLVED}</span>}
                        </div>
                        {/* 🔴 메타 줄(타입 · robotId/equipmentId)은 지웠다(S15P11E101-879) —
                            "시스템 · orinka_01" 처럼 계약 id 가 그대로 노출됐고, 제목이
                            이미 무슨 일인지 말하므로 남는 정보가 없었다. */}
                      </div>
                      <div className="elog-card-right">
                        <div className="elog-card-time mono">{log.date ? `${log.date} ${log.time}` : log.time}</div>
                        <div className="elog-card-rel">{rel || '—'}</div>
                      </div>
                      <div className="elog-card-actions">
                        {canOperate && log.eventId != null && (
                          <button type="button" className="logact"
                            title={log.status === 'RESOLVED' ? '미해결로 되돌리기' : '이 이벤트를 해결 처리'}
                            aria-label={`${log.status === 'RESOLVED' ? '미해결로 되돌리기' : '해결 처리'} — ${log.msg}`}
                            disabled={resolving === log.eventId}
                            onClick={() => onResolve(log, log.status === 'RESOLVED' ? 'UNRESOLVED' : 'RESOLVED')}>
                            {resolving === log.eventId ? '…' : (log.status === 'RESOLVED' ? '되돌리기' : '해결')}
                          </button>
                        )}
                        {canOperate && log.eventId != null && (
                          <button type="button" className="logact" title="이 이벤트를 서버에서 삭제" style={{ color: '#B4655C' }}
                            aria-label={`이벤트 삭제 — ${log.msg}`} onClick={() => { setDelErr(null); setPending(log) }}>
                            삭제
                          </button>
                        )}
                        {canOperate && log.live && (
                          <button type="button" className="logact" title="화면에서 닫기 (서버 기록은 남습니다)"
                            aria-label={`경보 닫기 — ${log.msg}`} onClick={() => dismissAlert(log.id)}>
                            닫기
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
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
            </div>
          </div>
        </div>
      )}
      {simple && (
        <ul className={variant} style={{ listStyle: 'none', padding: 0 }}>
          {rows.length === 0 && (
            <li className="logrow">
              <b>{loading ? '이력 불러오는 중…' : (connected ? '경보 없음 — 수신 대기 중' : '실서버 연결 중…')}</b>
            </li>
          )}
          {rows.map((log) => (
            <li key={log.id} className={`logrow ${log.kind}`}>
              <i className={`logdot c-${log.kind === 'fire' || log.kind === 'heat' || log.kind === 'ok' ? log.kind : 'sub'}`} />
              <span className="logtime">{log.time}</span>
              {/* 간략 목록에서도 상세를 열 수 있어야 한다(S15P11E101-765).
                  지도·카메라를 보다가 무슨 일인지 확인하려고 이벤트 탭까지 옮겨 가면,
                  그 사이에 화면에서 눈을 뗀다 — 보던 자리에서 바로 열리게 한다.
                  eventId 가 없는 줄(저장 전 실시간 수신분)은 열 상세가 없으므로 글자로 둔다. */}
              {log.eventId != null
                ? (
                  <button
                    type="button"
                    className={`logopen logtext t-${log.kind === 'fire' || log.kind === 'heat' || log.kind === 'ok' ? log.kind : 'ink'}`}
                    title="상세와 영상 보기"
                    onClick={() => setDetailId(log.eventId)}
                    style={{ background: 'transparent', border: 0, textAlign: 'left', cursor: 'pointer', padding: 0 }}
                  >
                    {log.msg}
                  </button>
                )
                : <span className={`logtext t-${log.kind === 'fire' || log.kind === 'heat' || log.kind === 'ok' ? log.kind : 'ink'}`}>{log.msg}</span>}
            </li>
          ))}
        </ul>
      )}

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
      {/* 선택 일괄 삭제 확인(S15P11E101-884) — 단건 삭제와 같은 문법의 모달이다 */}
      {bulkOpen && (
        <Modal title="선택한 이벤트를 삭제할까요?" onClose={() => setBulkOpen(false)} width={400}>
          <p className="cfg-help" style={{ marginBottom: 10 }}>
            선택한 <b>{checked.size}건</b>을 <b>서버에서 영구 삭제</b>합니다. 되돌릴 수 없습니다.
          </p>
          {delErr && <div className="form-msg err">삭제하지 못했습니다 — {delErr}</div>}
          <div className="gotor">
            <button type="button" className="dbtn" onClick={() => setBulkOpen(false)}>취소</button>
            <button type="button" className="dbtn stop" onClick={onBulkDelete} disabled={removing}>
              {removing ? '삭제 중…' : `${checked.size}건 삭제`}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
