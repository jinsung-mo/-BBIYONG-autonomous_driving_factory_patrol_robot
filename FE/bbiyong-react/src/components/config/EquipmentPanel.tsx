import { errMessage } from '../../live/errors.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import {
  STATUS_LABEL, eqId, eqName, inspectedAt, listEquipments, statusClass,
  updateThreshold, thresholdProblem,
} from '../../live/equipments.ts'

// 분전반 임계온도 (S15P11E101-836)
//
// 삐용봇이 순찰 중 분전반을 탐지하면 GET /api/equipments 목록에 올라온다. 여기서 각
// 분전반의 과열 기준(임계온도)을 정한다 — 로봇 명령 프로토콜에 SET_THRESHOLD 가 없어
// 로봇으로 하달하지 않고, 서버가 이 값을 저장해 '최근온도 > 임계온도' 면 과열로 판정한다
// (PUT /api/equipments/{id} { threshold }). 설정탭에 있던 '설비 현황' 을 운영탭으로 옮기며
// 685 에서 걷어냈던 임계온도 편집 UI 를 다시 붙였다.
export default function EquipmentPanel() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()

  const [rows, setRows] = useState<import('../../live/contracts.d.ts').Equipment[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)
  // 편집 중인 임계온도 초안. 저장 전까지 서버 값과 분리해 둔다.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true)
    try {
      const list = await listEquipments(accessToken)
      if (!alive.current) return
      setRows(list)
      setDrafts({})   // 서버 값이 새로 오면 초안을 버린다 — 저장이 반영됐는지 서버 값으로 본다
      setMsg(null)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `설비 목록을 불러오지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  const draftOf = (e: import('../../live/contracts.d.ts').Equipment) => {
    const id = eqId(e)
    const d = id != null ? drafts[id] : undefined
    return d ?? (e?.threshold != null ? String(e.threshold) : '')
  }

  const onSave = async (id: string) => {
    if (savingId) return
    const problem = thresholdProblem(drafts[id])
    if (problem) { setMsg({ kind: 'err', text: problem }); return }
    setSavingId(id)
    try {
      await updateThreshold(id, Number(drafts[id]), accessToken)
      if (!alive.current) return
      setMsg({ kind: 'ok', text: `임계온도를 저장했습니다. 최근온도가 기준을 넘으면 과열로 표시됩니다.` })
      await load()
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `임계온도를 저장하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setSavingId(null) }
  }

  return (
    <div className="card-v3" id="pgEquip">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>분전반 임계온도 <span className="k">EQUIPMENT</span></h3>
      <p className="cfg-help">
        삐용봇이 탐지한 분전반 목록입니다. 각 분전반의 <b>과열 임계온도</b>를 정하면, 이후 점검에서
        최근 온도가 기준을 넘을 때 과열로 표시·기록됩니다.
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
                    최근 온도: {typeof e?.lastTemperature === 'number' ? `${e.lastTemperature.toFixed(1)}℃` : '—'}
                    {at ? ` · 점검시각: ${at}` : ''}
                  </div>
                  {/* 임계온도 편집 — 저장하면 서버가 과열 판정에 쓴다 */}
                  <div className="gotor" style={{ marginTop: '6px' }}>
                    <input
                      type="number" min={1} step={0.5} inputMode="decimal"
                      value={draftOf(e)}
                      onChange={(ev) => id != null && setDrafts((d) => ({ ...d, [id]: ev.target.value }))}
                      placeholder="임계온도(℃)"
                      aria-label={`${eqName(e, i)} 임계온도`}
                      disabled={id == null || savingId != null}
                      style={{ width: '110px' }}
                    />
                    <span className="t" style={{ opacity: 0.7 }}>℃</span>
                    <button
                      type="button" className="btn-tonal"
                      onClick={() => id != null && onSave(id)}
                      disabled={id == null || savingId != null}
                      style={{ padding: '4px 10px' }}
                    >
                      {savingId === id ? '저장 중…' : '기준 저장'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          {rows.length === 0 && !loading && (
            <div className="cfg-note">아직 탐지된 분전반이 없습니다. 삐용봇이 순찰 중 분전반을 인식하면 여기에 올라옵니다.</div>
          )}
          <div className="gotor" style={{ marginTop: '12px' }}>
            <button type="button" id="btnReloadEq" className="btn-text" onClick={() => load()} disabled={loading}>
              {loading ? '불러오는 중…' : '목록 새로고침'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
