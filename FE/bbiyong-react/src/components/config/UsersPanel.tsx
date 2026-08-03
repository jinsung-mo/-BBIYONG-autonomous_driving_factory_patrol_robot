import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { errMessage, errStatus } from '../../live/errors.ts'
import { changeUserRole, isLastAdmin, isSelfDemotion, listUsers } from '../../live/adminUsers.ts'
import { ASSIGNABLE_ROLES, ROLE_ADMIN, ROLE_USER, roleText } from '../../auth/roles.ts'
import Modal from '../ui/Modal.tsx'

type AdminUser = import('../../live/contracts.d.ts').AdminUser

// 사용자 관리 (설정 탭 · 관리자 전용) — /api/admin/users (S15P11E101-614)
//
// 신규 가입자는 ROLE_USER 로 시작한다(S15P11E101-608). 관제를 조작하려면 관리자가
// 승격시켜 줘야 하므로, 그 일을 하는 화면이 여기다.
export default function UsersPanel() {
  const { enabled } = useLive()
  const { accessToken, isAdmin, canOperate, user, syncRole } = useAuth()

  const [rows, setRows] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // 되돌리기 어려운 변경만 확인을 받는다 — 자기 강등과 마지막 관리자 강등
  const [confirming, setConfirming] = useState<{ target: AdminUser, role: string, why: string } | null>(null)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async ({ keepMsg = false } = {}) => {
    if (!enabled || !accessToken || !isAdmin) return
    setLoading(true)
    if (!keepMsg) setMsg(null)
    try {
      const list = await listUsers(accessToken)
      if (alive.current) setRows(list)
    } catch (e) {
      // 403 은 "권한이 없다" 이지 "고장났다" 가 아니다 — 사유를 구분해 말한다.
      // 화면에서 관리자로 보이는데 서버가 거절하는 경우(다른 곳에서 강등됨)가 여기 걸린다.
      if (!alive.current) return
      setRows([])
      if (errStatus(e) === 403) {
        // 화면은 관리자로 알고 있는데 서버는 아니다 — 서버 판단을 받아 와 메뉴까지 맞춘다.
        // 이렇게 해야 강등된 계정이 관리자 화면을 계속 붙들고 있지 않는다(S15P11E101-626).
        setMsg({ kind: 'err', text: '이 계정에는 사용자 관리 권한이 없습니다. 권한을 다시 확인합니다…' })
        syncRole()
      } else {
        setMsg({ kind: 'err', text: `사용자 목록을 불러오지 못했습니다 — ${errMessage(e)}` })
      }
    } finally { if (alive.current) setLoading(false) }
  }, [enabled, accessToken, isAdmin, syncRole])

  useEffect(() => { load() }, [load])

  const apply = async (target: AdminUser, role: string) => {
    if (busy) return
    setBusy(target.email); setMsg(null)
    try {
      const updated = await changeUserRole(target.email, role, accessToken)
      // 서버가 바뀐 한 건을 돌려준다 — 목록을 다시 받지 않고 그 행만 고친다
      if (alive.current) {
        setRows((prev) => prev.map((u) => (u.email === target.email ? { ...u, ...updated } : u)))
        setMsg({ kind: 'ok', text: `${target.email} 을(를) ${roleText(role)}(으)로 변경했습니다.` })
      }
    } catch (e) {
      if (alive.current) {
        if (errStatus(e) === 403) {
          setMsg({ kind: 'err', text: '권한이 없어 변경하지 못했습니다. 권한을 다시 확인합니다…' })
          syncRole()
        } else {
          setMsg({ kind: 'err', text: `변경하지 못했습니다 — ${errMessage(e)}` })
        }
      }
    } finally { if (alive.current) { setBusy(null); setConfirming(null) } }
  }

  const onChange = (target: AdminUser, role: string) => {
    if (role === target.role) return
    // 스스로를 강등하면 이 화면까지 잃고, 마지막 관리자를 강등하면 되돌릴 사람이 없다.
    if (isSelfDemotion(target.email, user?.email, role)) {
      setConfirming({ target, role, why: '자기 자신을 강등하면 운영·설정 탭과 이 화면을 즉시 잃습니다. 다른 관리자만 되돌릴 수 있습니다.' })
      return
    }
    if (role !== ROLE_ADMIN && isLastAdmin(rows, target.email)) {
      setConfirming({ target, role, why: '마지막 관리자입니다. 강등하면 사용자를 승격시킬 수 있는 계정이 남지 않습니다.' })
      return
    }
    apply(target, role)
  }

  return (
    <div className="panel" id="pUsers">
      <h3>사용자 관리 <span className="k">USERS</span></h3>
      <p className="cfg-help">
        새로 가입한 계정은 <b>사용자</b>로 시작해 모니터링만 할 수 있습니다.
        로봇을 조작하거나 운영·설정 화면을 쓰려면 <b>관리자</b>로 승격해야 합니다.
      </p>

      {!enabled && <div className="cfg-note">시뮬레이션 모드에서는 조회되지 않습니다. 실서버 모드로 로그인하세요.</div>}

      {enabled && (
        <>
          {msg && <div className={`form-msg ${msg.kind}`} id="usrMsg">{msg.text}</div>}

          <ul className="usr-list" id="usrList">
            {rows.length === 0 && !loading && !msg && <li className="usr-empty">사용자가 없습니다.</li>}
            {rows.map((u) => {
              const me = !!user?.email && u.email.toLowerCase() === user.email.toLowerCase()
              return (
                <li key={u.id ?? u.email}>
                  <div className="usr-head">
                    <b>{u.name || u.email.split('@')[0]}</b>
                    {me && <span className="tag self">나</span>}
                    <span className={`tag ${u.role === ROLE_ADMIN ? 'on' : ''}`}>{roleText(u.role)}</span>
                  </div>
                  <div className="usr-mail mono">{u.email}</div>
                  <div className="gotor">
                    <select
                      aria-label={`${u.email} 권한`}
                      value={ASSIGNABLE_ROLES.some((r) => r.value === u.role) ? u.role : ROLE_USER}
                      disabled={busy === u.email}
                      onChange={(e) => onChange(u, e.target.value)}
                    >
                      {ASSIGNABLE_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    {busy === u.email && <span className="usr-busy">변경 중…</span>}
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="gotor">
            <button type="button" className="dbtn" onClick={() => load()} disabled={loading}>
              {loading ? '조회 중…' : '목록 새로 고침'}
            </button>
          </div>
        </>
      )}

      {confirming && (
        <Modal title="권한을 바꿀까요?" onClose={() => setConfirming(null)} width={440}>
          <p className="cfg-help" style={{ marginBottom: 12 }}>{confirming.why}</p>
          <div className="cfg-note mono">
            {confirming.target.email} · {roleText(confirming.target.role)} → {roleText(confirming.role)}
          </div>
          <div className="form-actions">
            <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>취소</button>
            <button type="button" id="btnConfirmRole" className="btn-primary"
              onClick={() => apply(confirming.target, confirming.role)}
              disabled={busy === confirming.target.email}>
              {busy === confirming.target.email ? '변경 중…' : '변경'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
