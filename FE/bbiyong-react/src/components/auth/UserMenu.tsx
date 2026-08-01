import { errMessage } from '../../live/errors.ts'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import { roleText } from '../../auth/roles.ts'
import Modal from '../ui/Modal.tsx'

const initials = (name) => (name || '?').replace(/\s/g, '').slice(0, 2)

// 마이페이지 모달 — 프로필 조회/수정
function MyPageModal({ onClose }) {
  const { user, updateProfile } = useAuth()
  const [name, setName] = useState(user.name)

  const [msg, setMsg] = useState('')
  const save = (e) => {
    e.preventDefault()
    // 권한은 본인이 바꿀 수 없다 — 편집 가능하면 권한 게이트가 무의미해진다(S15P11E101-475)
    updateProfile({ name: name.trim() || user.name })
    setMsg('저장되었습니다.')
  }
  return (
    <Modal title="마이페이지" onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-row"><label>이메일</label><input value={user.email} disabled /></div>
        <div className="form-row"><label>이름</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="form-row"><label>권한</label><input value={roleText(user.role)} disabled /></div>
        {msg && <div className="form-msg ok">{msg}</div>}
        <div className="form-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>닫기</button>
          <button type="submit" className="btn-primary">저장</button>
        </div>
      </form>
    </Modal>
  )
}

// 비밀번호 수정 모달
function PasswordModal({ onClose }) {
  const { changePassword } = useAuth()
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [next2, setNext2] = useState('')
  const [err, setErr] = useState(''); const [ok, setOk] = useState(false)
  const save = (e) => {
    e.preventDefault(); setErr('')
    try {
      if (next.length < 4) throw new Error('새 비밀번호는 4자 이상이어야 합니다.')
      if (next !== next2) throw new Error('새 비밀번호가 일치하지 않습니다.')
      changePassword(cur, next)
      setOk(true)
    } catch (e2) { setErr(errMessage(e2)) }
  }
  return (
    <Modal title="비밀번호 수정" onClose={onClose}>
      {ok ? (
        <>
          <div className="form-msg ok">비밀번호가 변경되었습니다.</div>
          <div className="form-actions"><button className="btn-primary" onClick={onClose}>확인</button></div>
        </>
      ) : (
        <form onSubmit={save}>
          <div className="form-row"><label>현재 비밀번호</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
          <div className="form-row"><label>새 비밀번호</label><input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
          <div className="form-row"><label>새 비밀번호 확인</label><input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} /></div>
          {err && <div className="form-msg err">{err}</div>}
          <div className="form-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>취소</button>
            <button type="submit" className="btn-primary">변경</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export default function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState(null) // 'mypage' | 'password' | null
  const ref = useRef(null)

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="usermenu" ref={ref}>
      <button className="usermenu-btn" onClick={() => setOpen((v) => !v)}>
        <span className="usermenu-av">{initials(user.name)}</span>
        <span className="usermenu-nm">{user.name}</span>
        <span className="usermenu-caret">▾</span>
      </button>
      {open && (
        <div className="usermenu-drop">
          <div className="usermenu-info">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </div>
          <button onClick={() => { setModal('mypage'); setOpen(false) }}>마이페이지</button>
          <button onClick={() => { setModal('password'); setOpen(false) }}>비밀번호 수정</button>
          <button className="danger" onClick={() => { setOpen(false); logout() }}>로그아웃</button>
        </div>
      )}
      {modal === 'mypage' && <MyPageModal onClose={() => setModal(null)} />}
      {modal === 'password' && <PasswordModal onClose={() => setModal(null)} />}
    </div>
  )
}
