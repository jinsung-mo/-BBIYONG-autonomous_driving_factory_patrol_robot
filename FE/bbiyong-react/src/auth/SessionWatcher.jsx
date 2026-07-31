import { useEffect, useState } from 'react'
import { useAuth } from './AuthContext.jsx'
import Modal from '../components/ui/Modal.jsx'
import { idleRemaining } from './sessionPolicy.js'

// 사용자 조작을 활동으로 기록하고, 만료가 임박하면 경고를 띄운다 (S15P11E101-508).
// 로그인 상태에서만 마운트된다.
const INPUT_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove']

export default function SessionWatcher() {
  const { touch, warning, extendSession, logout } = useAuth()
  const [left, setLeft] = useState(0)

  useEffect(() => {
    // passive: 스크롤·터치 성능을 막지 않는다. capture: 하위에서 stopPropagation 해도 놓치지 않는다.
    const opts = { passive: true, capture: true }
    INPUT_EVENTS.forEach((e) => window.addEventListener(e, touch, opts))
    return () => INPUT_EVENTS.forEach((e) => window.removeEventListener(e, touch, opts))
  }, [touch])

  // 경고 중에만 남은 시간을 센다 — 평소에 1초 타이머를 돌릴 이유가 없다
  useEffect(() => {
    if (!warning) return undefined
    const tick = () => setLeft(Math.max(0, Math.ceil(idleRemaining() / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [warning])

  if (!warning) return null

  return (
    <Modal title="곧 자동 로그아웃됩니다" onClose={extendSession} width={420}>
      <p className="cfg-help" id="sessionWarnBody" style={{ marginBottom: 12 }}>
        장시간 활동이 없어 <b className="num">{left}</b>초 뒤 로그아웃됩니다.
        계속 사용하시겠습니까?
      </p>
      <p className="cfg-help" style={{ marginBottom: 12, opacity: 0.75 }}>
        순찰·과열·화재 이벤트가 새로 기록되면 자동으로 연장됩니다.
      </p>
      <div className="gotor">
        <button type="button" className="dbtn" onClick={() => logout()}>지금 로그아웃</button>
        <button type="button" id="btnExtendSession" className="dbtn go" onClick={extendSession}>계속 사용</button>
      </div>
    </Modal>
  )
}
