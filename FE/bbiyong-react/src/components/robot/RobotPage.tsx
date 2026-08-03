import { useEffect, useRef } from 'react'
import { useSim } from '../../SimContext.ts'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import SummaryBar from '../dashboard/SummaryBar.tsx'
import StatusPanel from './StatusPanel.tsx'
import ControlPanel from './ControlPanel.tsx'
import MapPanel from './MapPanel.tsx'
import CapBadge from './CapBadge.tsx'

// 순찰 로봇 관제 (다크 테마) — 단일 화면
export default function RobotPage() {
  const { status, refs, actions } = useSim()
  const { enabled, telemetry, videoSeen } = useLive()
  const { settings } = useSettings()
  const glassRef = useRef<HTMLElement | null>(null)

  // 열화상 경고·임계 기준을 설정 값으로 맞춘다(S15P11E101-475 설정 탭)
  useEffect(() => {
    actions.setTempThresholds(settings.tempWarn, settings.tempCritical)
  }, [actions, settings.tempWarn, settings.tempCritical])

  // Liquid Glass의 스펙큘러 하이라이트가 포인터를 천천히 따라가도록
  // 페이지 좌표를 CSS 변수로 전달한다. 데이터 렌더링과 분리해 재렌더는 일으키지 않는다.
  useEffect(() => {
    const root = glassRef.current
    if (enabled || !root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let frame = 0
    const onPointerMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = root.getBoundingClientRect()
        const x = ((event.clientX - rect.left) / rect.width) * 100
        const y = ((event.clientY - rect.top) / rect.height) * 100
        root.style.setProperty('--glass-x', `${Math.max(0, Math.min(100, x))}%`)
        root.style.setProperty('--glass-y', `${Math.max(0, Math.min(100, y))}%`)
      })
    }

    root.addEventListener('pointermove', onPointerMove, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('pointermove', onPointerMove)
    }
  }, [enabled])

  // live 모드에서 로봇 서브시스템이 죽어 있거나 프레임이 한 번도 오지 않았으면
  // 그 패널을 흐리게 하고 안내를 덮는다. 캔버스에는 시뮬 화면이 남아 있어서,
  // 덮지 않으면 목업이 실데이터로 보인다 — 이번 작업의 핵심이다(S15P11E101-462).
  // 열화상은 로봇이 아예 생산하지 않아 항상 여기에 해당한다.
  const camDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.camera)) || !videoSeen.FRONT)
  const thermalDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.thermal)) || !videoSeen.THERMAL)

  return (
    // 시뮬레이션 화면에만 새 스킨을 입힌다. 실서버 화면은 지금 디자인을 그대로 둔다 —
    // 운영 중인 관제 화면을 시연용 개편과 한 번에 바꾸지 않는다.
    <section ref={glassRef} id="pgB" className={`page on${enabled ? '' : ' sim-skin'}`}>
      {/* 편성 전체 집계 — 실서버 모드에서만 나온다 */}
      <SummaryBar />
      <div className="b-grid">
        <StatusPanel />

        <div className="panel" id="pCam">
          <h3>
            순찰 로봇 카메라 <span className="k">FRONT · YOLOv11n</span>
            <CapBadge capKey={CAP_KEYS.camera} />
          </h3>
          <div className={`vwrap${camDown ? ' down' : ''}`}>
            <canvas ref={refs.rcam} />
            <span className="hud">{status.rcamHud}</span>
            <span className="rec">● REC 00:00</span>
            {camDown && <span className="nodata">전면 카메라 영상 없음</span>}
          </div>
        </div>

        <ControlPanel />

        {/* 우측 열: 열화상 + 2D 맵을 50/50 동일 높이로 분할 */}
        <div className="b-right">
          <div className="panel" id="pThermal">
            <h3>
              순찰 로봇 열화상 카메라 <span className="k">THERMAL</span>
              <CapBadge capKey={CAP_KEYS.thermal} />
            </h3>
            <div className={`vwrap${thermalDown ? ' down' : ''}`}>
              <canvas ref={refs.tcam} />
              {!thermalDown && (
                <span className="hud2" style={{ color: status.thermalColor }}>{status.thermalMax}</span>
              )}
              {thermalDown && <span className="nodata">열화상 미탑재 — 데이터 없음</span>}
            </div>
          </div>
          <MapPanel />
        </div>
      </div>
    </section>
  )
}
