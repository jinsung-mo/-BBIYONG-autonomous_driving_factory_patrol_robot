import { useEffect, useRef, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import SummaryBar from '../dashboard/SummaryBar.tsx'
import StatusPanel from './StatusPanel.tsx'
import ControlPanel from './ControlPanel.tsx'
import MapPanel from './MapPanel.tsx'
import CapBadge from './CapBadge.tsx'
import HlsVideo from './HlsVideo.tsx'
import DetectionOverlay from './DetectionOverlay.tsx'
import type { HlsHealth } from './HlsVideo.tsx'

// 순찰 로봇 관제 (다크 테마) — 단일 화면
export default function RobotPage() {
  const { status, refs, actions } = useSim()
  const { enabled, telemetry, videoSeen } = useLive()
  const { settings } = useSettings()

  // 열화상 경고·임계 기준을 설정 값으로 맞춘다(S15P11E101-475 설정 탭)
  useEffect(() => {
    actions.setTempThresholds(settings.tempWarn, settings.tempCritical)
  }, [actions, settings.tempWarn, settings.tempCritical])

  // 포인터를 따라가는 스펙큘러 하이라이트는 걷어냈다. 좌표를 CSS 변수 하나로 넘기면
  // 판마다 그 위치에 원이 하나씩 그려져 광원이 다섯 개가 된다 — 유리가 아니라 얼룩이다.
  // 반사광은 한 방향에서 오는 고정 그라데이션으로 충분하고, 포인터 추적 비용도 사라진다.

  // live 모드에서 로봇 서브시스템이 죽어 있거나 프레임이 한 번도 오지 않았으면
  // 그 패널을 흐리게 하고 안내를 덮는다. 캔버스에는 시뮬 화면이 남아 있어서,
  // 덮지 않으면 목업이 실데이터로 보인다 — 이번 작업의 핵심이다(S15P11E101-462).
  // 열화상은 로봇이 아예 생산하지 않아 항상 여기에 해당한다.
  // 🔴 [2026-08-12] CameraPage 와 같은 이유로 videoSeen.FRONT 를 쓰지 않는다 — 영상이
  //    WebSocket 을 떠나 그 값이 영원히 false 다. HLS 재생 상태로 판정한다.
  const [hlsHealth, setHlsHealth] = useState<HlsHealth>('loading')
  // 검출 박스 오버레이가 이 <video> 의 표시 영역·해상도를 읽어 좌표를 환산한다.
  const frontVideoRef = useRef<HTMLVideoElement | null>(null)
  const camDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.camera)) || hlsHealth === 'error')
  const thermalDown = enabled && (isDown(capOf(telemetry, CAP_KEYS.thermal)) || !videoSeen.THERMAL)

  return (
    // 시뮬레이션 화면에만 새 스킨을 입힌다. 실서버 화면은 지금 디자인을 그대로 둔다 —
    // 운영 중인 관제 화면을 시연용 개편과 한 번에 바꾸지 않는다.
    <section id="pgB" className="page on sim-skin nav-page">
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
            {/* 라이브는 HLS, 시뮬레이션은 종전 캔버스(Simulation.drawRcam 이 그린다) */}
            {enabled ? (
              <>
                <HlsVideo onHealth={setHlsHealth} videoRef={frontVideoRef} />
                {/* 🔴 박스는 영상보다 약 6초 앞서 도착한다(WS 즉시 vs HLS 지연).
                    DetectionOverlay 가 captureTs 로 시각을 맞춰 꺼낸다. */}
                <DetectionOverlay videoRef={frontVideoRef} />
              </>
            ) : <canvas ref={refs.rcam} />}
            {/* HUD·REC 는 시뮬 화면의 장식이다. 라이브에서는 REC 가 실제 녹화 상태가 아니고
                (녹화는 AWS 의 HLS 세그먼트 보관이다) HUD 도 시뮬 상태 문자열이라 내지 않는다. */}
            {!enabled && <span className="hud">{status.rcamHud}</span>}
            {!enabled && <span className="rec">● REC 00:00</span>}
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
