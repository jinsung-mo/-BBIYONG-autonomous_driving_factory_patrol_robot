import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import {
  TILT_MIN, TILT_MAX, TILT_STEP, atMax, atMin, clampTilt, formatTilt, reportedTilt,
} from '../../live/cameraTilt.ts'

// 전면 카메라 상하 각도 조작 (S15P11E101-521).
//
// 수동 조작 패널 안, 주행 속도 게이지 바로 아래에 둔다. 같은 패널에서 조작 언어가
// 어긋나지 않도록 '− / 게이지 / +' 배치를 그대로 따른다.
//
// 게이트는 주행과 다르다 — 주행 노드가 죽어도 카메라는 움직일 수 있어야 하므로
// drive 가 아니라 camera capability 를 본다.
export default function CameraTilt() {
  const { enabled, connected, control, telemetry } = useLive()
  // 조작 잠금(S15P11E101-653)도 함께 본다. isAdmin 만 보면 잠긴 동안에도 각도가 움직여
  // 다른 조작은 다 막혀 있는데 카메라만 돌아가는 상태가 된다.
  const { canOperate } = useAuth()

  const [requested, setRequested] = useState(0)
  const reported = reportedTilt(telemetry)
  // 로봇이 보고하면 그 값이 정답. 아직이면 마지막으로 보낸 값을 '요청'으로 표시한다 —
  // 보고값처럼 보이면 조작자가 실제 자세를 오해한다.
  const tilt = reported ?? requested

  const camDown = enabled && isDown(capOf(telemetry, CAP_KEYS.camera))
  // 시뮬 모드에서도 조작할 수 있어야 한다 — 긴급정지·순찰복귀·속도·지점이동이 모두 시뮬에서
  // 동작하는데 카메라 각도만 죽어 있으면 고장으로 읽힌다. 값만 바뀌고 발행은 하지 않는다.
  const off = enabled ? (!connected || camDown || !canOperate) : !canOperate

  const nudge = useCallback((dir: any) => {
    const next = clampTilt(tilt + dir * TILT_STEP)
    if (next === tilt) return          // 한계 — 같은 값을 다시 보내지 않는다
    setRequested(next)
    if (enabled) control.setCameraTilt(next)   // 시뮬에서는 보낼 로봇이 없다
  }, [tilt, control, enabled])

  // 핸들러가 매 렌더 새로 만들어지므로 ref 로 읽는다(리스너 재등록 방지)
  const latest = useRef<any>(null)
  latest.current = { nudge }

  useEffect(() => {
    if (off) return undefined
    const isTyping = (el: any) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
    const onKey = (e: any) => {
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

  const pct = ((tilt - TILT_MIN) / (TILT_MAX - TILT_MIN)) * 100

  return (
    <div className="spd camtilt" id="camTilt">
      <div className="spdlab">
        {/* 가동 범위는 라벨 줄에 붙인다 — 따로 한 줄을 쓰면 패널 아래로 밀려 잘린다 */}
        <span>카메라 각도 <em className="camtilt-range mono">{formatTilt(TILT_MIN)} ~ {formatTilt(TILT_MAX)}</em></span>
        <span className="camtilt-val">
          <b className="mono">{formatTilt(tilt)}</b>
          {/* 보고값 / 요청값 / 시뮬값을 구분한다 — 실제 자세로 오해하면 안 된다 */}
          <i title={!enabled
            ? '시뮬레이션 값입니다. 로봇으로 전송되지 않습니다.'
            : (reported == null
              ? '로봇이 아직 각도를 보고하지 않아 마지막으로 보낸 값입니다. 실제 자세와 다를 수 있습니다.'
              : '로봇이 보고한 현재 각도입니다.')}
          >{!enabled ? '시뮬' : (reported == null ? '요청' : '현재')}</i>
        </span>
      </div>
      <div className="spdr">
        <button
          type="button" id="btnTiltDown" className="dbtn"
          onClick={() => nudge(-1)} disabled={off || atMin(tilt)}
          aria-label={`카메라 아래로 ${TILT_STEP}도`} aria-keyshortcuts=","
          title={atMin(tilt) ? `가동 범위 하한 ${formatTilt(TILT_MIN)}` : `아래로 ${TILT_STEP}° ( , )`}
        >▼</button>
        <div
          className="spdbar"
          role="slider"
          aria-label="카메라 상하 각도"
          aria-valuemin={TILT_MIN}
          aria-valuemax={TILT_MAX}
          aria-valuenow={tilt}
          aria-valuetext={formatTilt(tilt)}
        >
          <i style={{ width: `${pct}%` }} />
        </div>
        <button
          type="button" id="btnTiltUp" className="dbtn"
          onClick={() => nudge(1)} disabled={off || atMax(tilt)}
          aria-label={`카메라 위로 ${TILT_STEP}도`} aria-keyshortcuts="."
          title={atMax(tilt) ? `가동 범위 상한 ${formatTilt(TILT_MAX)}` : `위로 ${TILT_STEP}° ( . )`}
        >▲</button>
      </div>
    </div>
  )
}
