import { errMessage, errStatus } from '../../live/errors.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import {
  STATUS_LABEL, eqId, eqName, inspectedAt, listEquipments, statusClass,
  thresholdProblem, updateThreshold,
} from '../../live/equipments.ts'

// 설비(분전반)별 과열 임계 온도 (S15P11E101-525).
//
// 화면 표시용 임계(설정 탭의 '열화상 임계 온도')와는 다른 값이다. 이쪽은 로봇이 과열을
// 판정하는 기준이라 저장하면 로봇까지 내려간다(BE 가 SET_THRESHOLD 로 중계).
export default function EquipmentPanel() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()

  const [rows, setRows] = useState<import('../../live/contracts.d.ts').Equipment[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})   // id → 입력 중인 문자열
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<string | null>(null) // 저장 중인 id
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)       // { kind, text }

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // keepMsg: 저장 직후의 재조회는 성공 안내를 지우면 안 된다(안내가 한순간도 안 보인다).
  const load = useCallback(async ({ keepMsg = false } = {}) => {
    if (!enabled || !accessToken) return
    setLoading(true)
    try {
      const list = await listEquipments(accessToken)
      if (!alive.current) return
      setRows(list)
      setDrafts({})            // 서버 값이 정답 — 입력 초안은 버린다
      if (!keepMsg) setMsg(null)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `설비 목록을 불러오지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  const shown = (e: any) => drafts[eqId(e) || ''] ?? String(e?.threshold ?? '')
  const setDraft = (id: any, v: any) => setDrafts((prev) => ({ ...prev, [id]: v }))

  const onSave = async (e: any, i: any) => {
    const id = eqId(e)
    if (!id || saving) return
    const raw = shown(e)
    const bad = thresholdProblem(raw)
    if (bad) { setMsg({ kind: 'err', text: `${eqName(e, i)} — ${bad}` }); return }
    setSaving(id)
    try {
      await updateThreshold(id, Number(raw), accessToken)
      if (!alive.current) return
      // PUT 응답은 { status } 뿐이라 갱신값이 없다. 목록을 다시 받아 서버 값을 확정한다.
      await load({ keepMsg: true })
      if (!alive.current) return
      setMsg({ kind: 'ok', text: `${eqName(e, i)} 임계 온도를 ${Number(raw)}℃ 로 저장했습니다 — 로봇에도 반영됩니다.` })
    } catch (err) {
      if (!alive.current) return
      setMsg(errStatus(err) === 404
        ? { kind: 'err', text: `${eqName(e, i)}(${id}) 를 서버에서 찾을 수 없습니다. 목록을 새로고침하세요.` }
        : { kind: 'err', text: `저장하지 못했습니다 — ${errMessage(err)}` })
    } finally { if (alive.current) setSaving(null) }
  }

  const dirty = (e: any) => {
    const d = drafts[eqId(e) || '']
    return d !== undefined && Number(d) !== Number(e?.threshold)
  }

  return (
    <div className="panel" id="pgEquip">
      <h3>설비별 과열 임계 온도 <span className="k">EQUIPMENT</span></h3>
      <p className="cfg-help">
        분전반마다 로봇이 <b>과열로 판정할 기준 온도</b>입니다. 저장하면 서버에 기록되고
        로봇에도 반영됩니다(<b className="mono">SET_THRESHOLD</b>).
        <b>열화상 임계 온도</b> 설정은 화면 색 표시 기준이라 별개 값입니다.
      </p>

      {!enabled && <div className="cfg-note">시뮬레이션 모드에서는 조회되지 않습니다. 실서버 모드로 로그인하세요.</div>}

      {enabled && (
        <>
          {msg && <div className={`form-msg ${msg.kind}`} id="eqMsg">{msg.text}</div>}
          <ul className="eq-list" id="eqList">
            {rows.map((e, i) => {
              const id = eqId(e)
              const st = (e?.status || 'UNKNOWN').toUpperCase()
              const at = inspectedAt(e?.lastInspectedAt)
              return (
                <li key={id ?? i}>
                  <div className="eq-head">
                    <b>{eqName(e, i)}</b>
                    <span className="t mono">{id}</span>
                    <span className={`tag ${statusClass(st)}`}>{STATUS_LABEL[st] || st}</span>
                  </div>
                  <div className="eq-meta mono">
                    최근 {typeof e?.lastTemperature === 'number' ? `${e.lastTemperature.toFixed(1)}℃` : '—'}
                    {at ? ` · ${at}` : ''}
                  </div>
                  <div className="gotor">
                    <input
                      type="number" step="0.5" min="0"
                      aria-label={`${eqName(e, i)} 임계 온도 (℃)`}
                      value={shown(e)}
                      onChange={(ev) => setDraft(id, ev.target.value)}
                      disabled={saving === id}
                    />
                    <button
                      type="button" className="dbtn go"
                      onClick={() => onSave(e, i)}
                      disabled={saving === id || !dirty(e) || !!thresholdProblem(shown(e))}
                    >
                      {saving === id ? '저장 중…' : `저장${dirty(e) ? ' *' : ''}`}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          {rows.length === 0 && !loading && (
            <div className="cfg-note">등록된 설비가 없습니다.</div>
          )}
          <div className="gotor">
            <button type="button" id="btnReloadEq" className="dbtn" onClick={() => load()} disabled={loading}>
              {loading ? '불러오는 중…' : '목록 새로고침'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
