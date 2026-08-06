import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { useZones } from '../../live/ZoneContext.tsx'
import { errMessage, errStatus } from '../../live/errors.ts'
import { deleteZone, seedGrid, updateZone } from '../../live/zones.ts'
import type { Zone } from '../../live/contracts.d.ts'

// 구역 편집 (S15P11E101-770)
//
// 관리자가 구역 이름을 정하는 자리다. 좌표를 직접 치게 하지 않는다 —
// 사각형 네 값을 손으로 맞추는 일은 아무도 정확히 못 한다.
// 격자는 서버가 활성 맵 경계로 만들어 주고(seed-grid), 여기서는 이름만 고친다.

const ROWS = 3
const COLS = 3

// 미터 값을 짧게. 구역 상자를 눈으로 대조할 때만 쓰는 값이라 소수점 한 자리면 된다.
const m = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—')

export default function ZonePanel() {
  const { enabled, plan } = useLive()
  const { isAdmin, accessToken } = useAuth()
  const { zones, reload } = useZones()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [confirmReplace, setConfirmReplace] = useState(false)

  // 서버 목록이 바뀌면 편집 중이던 이름을 새로 맞춘다
  useEffect(() => {
    setDraft(Object.fromEntries(zones.map((z) => [z.id, z.name])))
  }, [zones])

  const run = useCallback(async (fn: () => Promise<any>, okText: string) => {
    setBusy(true); setMsg(null)
    try {
      await fn()
      await reload()
      setMsg({ kind: 'ok', text: okText })
    } catch (e) {
      setMsg({ kind: 'err', text: errMessage(e) })
      return errStatus(e)
    } finally { setBusy(false) }
    return 0
  }, [reload])

  const onSeed = async (replace: boolean) => {
    setConfirmReplace(false)
    const st = await run(() => seedGrid({ rows: ROWS, cols: COLS, replace }, accessToken),
      replace ? '격자를 다시 만들었습니다.' : '기본 격자를 만들었습니다.')
    // 409 는 '이미 있다' 는 뜻이다. 지우고 다시 만들지 물어본다 —
    // 이름을 붙여 둔 구역을 말없이 날리면 안 된다.
    if (st === 409) setConfirmReplace(true)
  }

  const onRename = (z: Zone) => {
    const name = (draft[z.id] || '').trim()
    if (!name || name === z.name) return
    run(() => updateZone(z.id, { ...z, name }, accessToken), `'${name}' 으로 바꿨습니다.`)
  }

  const locked = !enabled || !isAdmin || busy

  return (
    <div className="card-v3" id="pZones">
      <h3>구역 <span className="k">ZONES</span></h3>
      <p className="cfg-help">
        화면의 위치 표기를 좌표 대신 구역 이름으로 보여 줍니다.
        격자는 활성 맵 경계를 기준으로 서버가 만들고, 여기서는 이름만 고칩니다.
      </p>

      {!enabled && <div className="cfg-note">실서버 모드에서만 조회·편집됩니다.</div>}
      {enabled && !isAdmin && <div className="cfg-note">구역 편집은 관리자만 할 수 있습니다.</div>}
      {enabled && !plan && (
        <div className="cfg-note">활성 도면이 없습니다. 매핑을 마친 뒤 격자를 만드세요.</div>
      )}
      {msg && <div className={`form-msg ${msg.kind}`} id="zoneMsg">{msg.text}</div>}

      {enabled && (
        <>
          <div className="gotor">
            <button
              type="button" id="btnSeedZones" className="btn-filled"
              onClick={() => onSeed(false)} disabled={locked}
            >
              {ROWS}×{COLS} 기본 격자 만들기
            </button>
            <button type="button" className="btn-text" onClick={reload} disabled={busy}>다시 불러오기</button>
          </div>

          {confirmReplace && (
            <div className="cfg-note">
              <b>이미 구역이 있습니다.</b> 다시 만들면 지금 이름들이 사라집니다.
              <div className="gotor" style={{ marginTop: 8 }}>
                <button type="button" className="btn-text" onClick={() => setConfirmReplace(false)}>취소</button>
                <button type="button" id="btnSeedReplace" className="basebtn danger"
                  onClick={() => onSeed(true)} disabled={busy}>
                  지우고 다시 만들기
                </button>
              </div>
            </div>
          )}

          {!zones.length
            ? <div className="cfg-note">등록된 구역이 없습니다. 기본 격자부터 만드세요.</div>
            : (
              <ul className="zone-list">
                {zones.map((z) => (
                  <li key={z.id}>
                    <input
                      className="zone-name"
                      value={draft[z.id] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [z.id]: e.target.value }))}
                      onBlur={() => onRename(z)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      disabled={locked}
                      aria-label={`${z.name} 이름`}
                    />
                    {/* 좌표는 읽기 전용이다. 손으로 맞추는 일은 아무도 정확히 못 한다. */}
                    <span className="zone-rect mono">
                      ({m(z.x1)}, {m(z.y1)}) ~ ({m(z.x2)}, {m(z.y2)}) m
                    </span>
                    <button
                      type="button" className="btn-text zone-del"
                      onClick={() => run(() => deleteZone(z.id, accessToken), `'${z.name}' 을 지웠습니다.`)}
                      disabled={locked}
                      aria-label={`${z.name} 삭제`}
                    >
                      삭제
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  )
}
