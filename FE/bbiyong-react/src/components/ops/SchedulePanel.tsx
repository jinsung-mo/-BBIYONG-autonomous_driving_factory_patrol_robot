import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useFleet } from '../../live/FleetContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { errMessage } from '../../live/errors.ts'
import {
  CRON_PRESETS, createSchedule, cronProblem, cronText, deleteSchedule,
  fetchSchedules, lastRunText, updateSchedule,
} from '../../live/schedules.ts'
import Modal from '../ui/Modal.tsx'

type Schedule = import('../../live/contracts.d.ts').PatrolSchedule

// 자동 순찰 스케줄 (운영 탭) — /api/patrol-schedules
//
// 지금은 사람이 퇴근 전에 관제에 들어와 순찰을 시작한다. 스케줄을 걸어 두면
// 그 시각에 서버가 대신 띄운다 — 20시~08시 무인 운영과 맞물리는 기능이다.
export default function SchedulePanel() {
  const { enabled } = useLive()
  // 새 스케줄은 관제 화면에서 고른 로봇으로 만든다(S15P11E101-591)
  const { selected: robotId, robotName, multi } = useFleet()
  const { accessToken, isAdmin, canOperate } = useAuth()

  const [rows, setRows] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)
  const [busy, setBusy] = useState<number | 'new' | null>(null)
  const [pending, setPending] = useState<Schedule | null>(null)   // 삭제 확인 대기

  // 새 스케줄 입력값
  const [name, setName] = useState('')
  const [cron, setCron] = useState(CRON_PRESETS[0].value)
  const [custom, setCustom] = useState(false)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async ({ keepMsg = false } = {}) => {
    if (!enabled || !accessToken) return
    setLoading(true)
    if (!keepMsg) setMsg(null)
    try {
      const list = await fetchSchedules(null, accessToken)
      if (alive.current) setRows(list)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `스케줄을 불러오지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  const cronProb = cronProblem(cron)
  const cronDesc = cronText(cron)

  const onCreate = async () => {
    if (busy || cronProb) return
    const nm = name.trim()
    if (!nm) { setMsg({ kind: 'err', text: '스케줄 이름을 입력하세요.' }); return }
    setBusy('new')
    try {
      await createSchedule({ name: nm, robotId, cronExpression: cron.trim(), enabled: true }, accessToken)
      setName('')
      await load({ keepMsg: true })
      if (alive.current) setMsg({ kind: 'ok', text: `'${nm}' 스케줄을 추가했습니다.` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `추가하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(null) }
  }

  // 활성/비활성 토글도 PUT 이다 — 서버가 부분 수정을 받지 않아 전체 필드를 다시 보낸다.
  const onToggle = async (s: Schedule) => {
    if (busy) return
    setBusy(s.scheduleId)
    try {
      await updateSchedule(s.scheduleId, {
        name: s.name, robotId: s.robotId, cronExpression: s.cronExpression, enabled: !s.enabled,
      }, accessToken)
      await load({ keepMsg: true })
      if (alive.current) setMsg({ kind: 'ok', text: `'${s.name}' 스케줄을 ${s.enabled ? '중지' : '실행'}했습니다.` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `변경하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(null) }
  }

  const onDelete = async () => {
    if (!pending || busy) return
    setBusy(pending.scheduleId)
    try {
      await deleteSchedule(pending.scheduleId, accessToken)
      setPending(null)
      await load({ keepMsg: true })
      if (alive.current) setMsg({ kind: 'ok', text: `'${pending.name}' 스케줄을 삭제했습니다.` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `삭제하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(null) }
  }

  return (
    <div className="card-v3" id="pSchedule">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>자동 순찰 스케줄 <span className="k">PATROL SCHEDULE</span></h3>
      <p className="cfg-help">
        정한 시각에 서버가 순찰을 시작합니다. 삐용은 공장이 비는 <b>20시~08시</b>에 운행하므로
        보통 퇴근 시각에 맞춰 걸어 둡니다.
      </p>

      {!enabled && <div className="cfg-note">시뮬레이션 모드에서는 조회되지 않습니다. 실서버 모드로 로그인하세요.</div>}

      {enabled && (
        <>
          {msg && <div className={`form-msg ${msg.kind}`} id="schMsg">{msg.text}</div>}

          <ul className="sch-list" id="schList">
            {rows.length === 0 && !loading && <li className="sch-empty">등록된 스케줄이 없습니다.</li>}
            {rows.map((s) => (
              <li key={s.scheduleId} className={s.enabled ? '' : 'off'}>
                <div className="sch-head">
                  <b>{s.name}</b>
                  <span className={`tag ${s.enabled ? 'on' : ''}`}>{s.enabled ? '실행 중' : '중지'}</span>
                </div>
                {/* 해석되면 사람 말로, 아니면 표현식을 그대로 — 틀린 설명을 보여 주지 않는다 */}
                <div className="sch-when">{cronText(s.cronExpression) || <span className="mono">{s.cronExpression}</span>}</div>
                <div className="sch-meta">{robotName(s.robotId)} · <span className="mono">최근 실행 {lastRunText(s.lastExecuted)}</span></div>
                {canOperate && (
                  <div className="gotor">
                    <button type="button" className="btn-text" disabled={busy === s.scheduleId}
                      onClick={() => onToggle(s)}>
                      {s.enabled ? '중지' : '실행'}
                    </button>
                    <button type="button" className="btn-text" disabled={busy === s.scheduleId}
                      onClick={() => { setMsg(null); setPending(s) }} style={{ color: '#B4655C' }}>
                      삭제
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {canOperate && (
            <div className="sch-new">
              {multi && <div className="cfg-note">새 스케줄은 <b>{robotName(robotId)}</b> 앞으로 만듭니다.</div>}
              <div className="form-row">
                <label htmlFor="sch-name">새 스케줄 이름</label>
                <input id="sch-name" value={name} maxLength={40}
                  placeholder="예: 야간 순찰" onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="form-row">
                <label htmlFor="sch-cron">주기</label>
                {custom
                  ? <input id="sch-cron" className="mono" value={cron}
                      placeholder="0 0 20 * * *" onChange={(e) => setCron(e.target.value)} />
                  : (
                    <select id="sch-cron" value={cron} onChange={(e) => setCron(e.target.value)}>
                      {CRON_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  )}
              </div>
              <label className="sch-custom">
                <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
                Cron 직접 입력
              </label>
              {custom && (
                <div className="cfg-note">
                  Spring 표현식은 <b>6필드</b>입니다 — 초 분 시 일 월 요일.
                  {cronProb
                    ? <div className="form-msg err">{cronProb}</div>
                    : <div>해석: <b>{cronDesc || '서버가 판정합니다'}</b></div>}
                </div>
              )}
              <div className="gotor">
                <button type="button" className="btn-filled" onClick={onCreate}
                  disabled={busy === 'new' || !name.trim() || !!cronProb}>
                  {busy === 'new' ? '추가 중…' : '스케줄 추가'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {pending && (
        <Modal title="스케줄 삭제" onClose={() => setPending(null)}>
          <p>‘{pending.name}’ 스케줄을 삭제합니다. 되돌릴 수 없습니다.</p>
          <div className="cfg-note mono">{pending.cronExpression}</div>
          <div className="gotor" style={{ marginTop: '20px' }}>
            <button type="button" className="btn-text" onClick={() => setPending(null)}>취소</button>
            <button type="button" className="btn-filled" onClick={onDelete}
              disabled={busy === pending.scheduleId}>
              {busy === pending.scheduleId ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
