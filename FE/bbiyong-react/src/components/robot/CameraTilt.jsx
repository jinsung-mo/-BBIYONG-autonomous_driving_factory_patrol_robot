import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.jsx'
import { useAuth } from '../../auth/AuthContext.jsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.js'
import {
  TILT_MIN, TILT_MAX, TILT_STEP, atMax, atMin, clampTilt, formatTilt, reportedTilt,
} from '../../live/cameraTilt.js'

// 전면 카메라 상하 각도 조작 (S15P11E101-521).
//
// 로봇이 현재 각도를 보고하면 그 값이 정답이다. 아직 보고하지 않으면 마지막으로 보낸
// 값을 '요청' 으로 표시한다 — 보고값처럼 보이면 조작자가 실제 자세를 오해한다.
export default function CameraTilt() {
  const { enabled, connected, control, telemetry } = useLive()
  const { isAdmin } = useAuth()

  const [requested, setRequested] = useState(0)
  const reported = reportedTilt(telemetry)
  const tilt = reported ?? requested

  const camDown = enabled && isDown(capOf(telemetry, CAP_KEYS.camera))
  // 뷰어는 조작할 수 없고, 카메라가 죽었으면 보낼 곳이 없다
  const off = !enabled || !connected || camDown || !isAdmin

  const nudge = useCallback((dir) => {
    const next = clampTilt(tilt + dir * TILT_STEP)
    if (next === tilt) return          // 한계 — 같은 값을 다시 보내지 않는다
    setRequested(next)
    control.setCameraTilt(next)
  }, [tilt, control])

  // 핸들러가 매 렌더 새로 만들어지므로 ref 로 읽는다(리스너 재등록 방지)
  const latest = useRef(null)
  latest.current = { nudge, off }

  useEffect(() => {
    if (off) return undefined
    const isTyping = (el) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
    const onKey = (e) => {
      // WASD·방향키·Space·Shift 는 주행과 모드에 이미 쓰인다 — 겹치지 않는 키를 쓴다
      const up = e.key === '.' || e.key === '>' || e.key === 'PageUp'
      const down = e.key === ',' || e.key === '<' || e.key === 'PageDown'
      if (!up && !down) return
      if (isTyping(e.target)) return
      e.preventDefault()
      latest.current.nudge(up ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [off])

  const upOff = off || atMax(tilt)
  const downOff = off || atMin(tilt)

  return (
    <div className="camtilt" id="camTilt">
      <span className="camtilt-val" aria-live="polite">
        <b className="mono">{formatTilt(tilt)}</b>
        <i title={reported == null
          ? '로봇이 아직 각도를 보고하지 않아 마지막으로 보낸 값입니다. 실제 자세와 다를 수 있습니다.'
          : '로봇이 보고한 현재 각도입니다.'}
        >{reported == null ? '요청' : '현재'}</i>
      </span>
      <button
        type="button" id="btnTiltUp" className="dbtn" onClick={() => nudge(1)} disabled={upOff}
        aria-label={`카메라 위로 ${TILT_STEP}도 (.)`}
        title={atMax(tilt) ? `가동 범위 상한 ${formatTilt(TILT_MAX)}` : `위로 ${TILT_STEP}° ( . )`}
      >▲</button>
      <button
        type="button" id="btnTiltDown" className="dbtn" onClick={() => nudge(-1)} disabled={downOff}
        aria-label={`카메라 아래로 ${TILT_STEP}도 (,)`}
        title={atMin(tilt) ? `가동 범위 하한 ${formatTilt(TILT_MIN)}` : `아래로 ${TILT_STEP}° ( , )`}
      >▼</button>
      <span className="camtilt-range mono">{formatTilt(TILT_MIN)} ~ {formatTilt(TILT_MAX)}</span>
    </div>
  )
}
