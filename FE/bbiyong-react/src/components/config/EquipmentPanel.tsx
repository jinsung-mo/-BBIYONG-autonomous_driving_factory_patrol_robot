import { errMessage } from '../../live/errors.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import {
  STATUS_LABEL, eqId, eqName, inspectedAt, listEquipments, statusClass,
} from '../../live/equipments.ts'

// 설비(분전반) 현황 (S15P11E101-685: 임계온도 수정 UI 및 PUT /api/equipments/{id} 제거)
export default function EquipmentPanel() {
  const { enabled } = useLive()
  const { accessToken } = useAuth()

  const [rows, setRows] = useState<import('../../live/contracts.d.ts').Equipment[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true)
    try {
      const list = await listEquipments(accessToken)
      if (!alive.current) return
      setRows(list)
      setMsg(null)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `설비 목록을 불러오지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  return (
    <div className="nx-card" id="pgEquip">
      <h3>설비 현황 <span className="k">EQUIPMENT</span></h3>
      <p className="cfg-help">
        관제 대상 분전반 목록 및 최신 상태 현황입니다.
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
                    {e?.threshold != null ? ` (기준 ${e.threshold}℃)` : ''}
                    {at ? ` · 점검시각: ${at}` : ''}
                  </div>
                </li>
              )
            })}
          </ul>
          {rows.length === 0 && !loading && (
            <div className="cfg-note">등록된 설비가 없습니다.</div>
          )}
          <div className="gotor" style={{ marginTop: '12px' }}>
            <button type="button" id="btnReloadEq" className="basebtn" onClick={() => load()} disabled={loading}>
              {loading ? '불러오는 중…' : '목록 새로고침'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
