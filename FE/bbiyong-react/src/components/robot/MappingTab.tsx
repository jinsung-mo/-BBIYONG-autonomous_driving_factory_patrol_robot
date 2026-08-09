import { useEffect, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import Modal from '../ui/Modal.tsx'
import RoutePanel from '../ops/RoutePanel.tsx'
import { useInspection } from '../../live/inspection.ts'
import { MAPPING_STATUS } from '../../live/mapping.ts'
import { playVoice } from '../../live/voice.ts'

// 지도 페이지의 '매핑' 탭 (S15P11E101 콘솔 정리 — 운영 탭에서 이동).
//
// 2D 맵 모델링(SLAM MAPPING)과 순찰 경로(PATROL ROUTE)를 한 화면에서 잇는다.
// 맵을 만들고 그 위에 경로를 그려 로봇에 하달하는 흐름이라 지도 페이지에 함께 둔다.
// 저장된 맵 목록·자동 순찰 스케줄은 제거됐다(활성 맵은 매핑 완료 시 서버가 자동 지정).
export default function MappingTab() {
  const { enabled, connected, control, onNavUpdate, telemetry, mapping, mappingComplete, clearMappingComplete } = useLive()
  const { locked } = useAuth()
  // 순찰 경로 지도에 확정 점검 지점을 얹어 준다(읽기 전용). 관리는 설정 탭으로 이동했다.
  const inspection = useInspection()

  const [nav, setNav] = useState<import('../../live/contracts.d.ts').DecodedMap | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [requested, setRequested] = useState(false)   // START_MAPPING 발행 후 로봇 반응 대기
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)

  // 실시간 맵 진행 상황 — /topic/nav 의 MAP 스냅샷을 그대로 본다
  useEffect(() => onNavUpdate((n: any) => setNav(n?.map ? { ...n.map } : null)), [onNavUpdate])

  // 진행 단계. 완료 이벤트 > 로봇이 보고하는 MAPPING > 발행 직후 대기 순으로 우선한다.
  const running = mapping || telemetry?.status === MAPPING_STATUS
  const phase = mappingComplete ? 'complete' : (running ? 'running' : (requested ? 'requested' : 'idle'))

  // 로봇이 매핑에 들어갔거나 끝났으면 '대기 중' 딱지는 역할이 끝났다
  useEffect(() => { if (running || mappingComplete) setRequested(false) }, [running, mappingComplete])

  // 🔴 FE 의 매핑 완료 자동 저장(SAVE_MAP + 시각 기반 이름 짓기)은 걷어냈다
  // [사용자 지침 2026-08-09] — 저장·도면 생성은 로봇/서버 쪽 흐름이 맡고,
  // 화면은 '매핑 완료' 사실만 알린다. 완료 표시는 다음 매핑 시작 때 지워진다(onStart).

  const onStart = () => {
    setConfirming(false)
    setMsg(null)
    clearMappingComplete()
    control.startMapping()
    setRequested(true)
    playVoice('mappingStart')   // "맵핑을 시작합니다"(01) — 버튼 클릭 제스처 직후라 재생 허용된다
  }

  const onStopMapping = () => {
    control.stopMapping()
    setRequested(false)
    setMsg({ kind: 'warn', text: '매핑 중단을 요청했습니다. 로봇이 멈추면 진행 표시가 사라집니다.' })
  }

  const offline = !enabled || !connected

  // 매핑 컨트롤 — 예전에는 좌측 별도 카드였다(S15P11E101-904). 순찰 경로 패널 상단에
  // 얹어 한 카드로 합치고, 맵이 화면을 크게 차지하게 한다. 시작/중단 버튼 한 줄 +
  // 진행 상태 한 줄로 얇게 둔다.
  const mappingControl = (
    <div className="mapping-control">
      <div className="mapping-control-head">
        <span className="mapping-control-title">2D 맵 모델링 <span className="k">SLAM MAPPING</span></span>
        <div className="mapping-actions">
          <button
            type="button" id="btnStartMapping" className="btn-filled"
            onClick={() => setConfirming(true)}
            disabled={offline || phase === 'running' || phase === 'requested'}
          >
            {phase === 'running' ? '매핑 진행 중…' : '맵 모델링 시작'}
          </button>
          {(phase === 'running' || phase === 'requested') && (
            <button
              type="button" id="btnStopMapping" className="btn-tonal" style={{ color: '#B4655C' }}
              onClick={onStopMapping} disabled={offline}
            >
              매핑 중단
            </button>
          )}
        </div>
      </div>
      {phase === 'requested' && (
        <div className="mapstat wait" id="mapPhase"><i /> 시작 명령을 보냈습니다 — 로봇이 매핑에 들어가면 진행 상황이 표시됩니다.</div>
      )}
      {phase === 'running' && (
        <div className="mapstat run" id="mapPhase"><i /> 매핑 진행 중 — 로봇이 자율 주행하며 맵을 넓히고 있습니다.</div>
      )}
      {phase === 'complete' && (
        <div className="mapstat done" id="mapPhase"><i /> <b>매핑 완료</b></div>
      )}
      {enabled && connected && !nav && phase === 'idle' && (
        <p className="cfg-help" style={{ marginTop: 8, marginBottom: 0 }}>아직 맵을 받지 못했습니다. 로봇의 라이다·SLAM 노드가 올라오면 여기에 진행 상황이 뜹니다.</p>
      )}
      {msg && <div className={`form-msg ${msg.kind}`} id="mapMsg">{msg.text}</div>}
    </div>
  )

  return (
    <fieldset className="lockfs" disabled={locked}>
      {/* 단일 카드가 화면을 다 채운다(S15P11E101-904) — 좌측 별도 카드를 없애고
          매핑 컨트롤을 순찰 경로 패널 상단에 통합했다. */}
      <div className="nav-canvas mapping-canvas">
        <RoutePanel
          title="실시간 매핑/순찰 모니터링"
          mappingControl={mappingControl}
          inspection={{
            candidates: inspection.candidates,
            points: inspection.points,
            selectedId: null,
          }}
        />
      </div>

      {confirming && (
        <Modal title="맵 모델링을 시작할까요?" onClose={() => setConfirming(false)} width={420}>
          <p className="cfg-help" style={{ marginBottom: 12 }}>
            로봇이 <b>순찰을 멈추고</b> 공장 안을 자율 주행하며 새 2D 맵을 만듭니다.
            주행 경로에 사람이나 장애물이 없는지 확인한 뒤 시작하세요.
          </p>
          <div className="gotor">
            <button type="button" className="btn-text" onClick={() => setConfirming(false)}>취소</button>
            <button type="button" id="btnStartMappingOk" className="btn-filled" onClick={onStart}>시작</button>
          </div>
        </Modal>
      )}
    </fieldset>
  )
}
