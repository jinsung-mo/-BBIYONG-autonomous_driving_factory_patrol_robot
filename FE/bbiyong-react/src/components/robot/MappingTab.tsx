import { useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import Modal from '../ui/Modal.tsx'
import RoutePanel from '../ops/RoutePanel.tsx'
import { useInspection } from '../../live/inspection.ts'
import { MAPPING_STATUS } from '../../live/mapping.ts'

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
  // 매핑 완료를 이미 저장했는지. 완료 이벤트가 재렌더로 여러 번 읽혀도 SAVE_MAP 을 한 번만 보낸다.
  const savedRef = useRef(false)

  // 실시간 맵 진행 상황 — /topic/nav 의 MAP 스냅샷을 그대로 본다
  useEffect(() => onNavUpdate((n: any) => setNav(n?.map ? { ...n.map } : null)), [onNavUpdate])

  // 진행 단계. 완료 이벤트 > 로봇이 보고하는 MAPPING > 발행 직후 대기 순으로 우선한다.
  const running = mapping || telemetry?.status === MAPPING_STATUS
  const phase = mappingComplete ? 'complete' : (running ? 'running' : (requested ? 'requested' : 'idle'))

  // 로봇이 매핑에 들어갔거나 끝났으면 '대기 중' 딱지는 역할이 끝났다
  useEffect(() => { if (running || mappingComplete) setRequested(false) }, [running, mappingComplete])

  // 매핑 완료 시 자동 저장 — 로봇이 붙인 이름, 없으면 시각 기반 기본 이름으로 SAVE_MAP.
  // 서버가 정제 도면(FLOORPLAN)을 만들어 활성 맵으로 지정하면 지도(3D)에 자동 반영된다.
  useEffect(() => {
    if (!mappingComplete) { savedRef.current = false; return }
    if (savedRef.current) return
    savedRef.current = true
    const suggested = (mappingComplete.name || '').trim()
    const mapName = suggested
      || `map_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
    setMsg({ kind: 'ok', text: `매핑 완료 — '${mapName}' 이름으로 자동 저장합니다. 서버가 정제 도면(FLOORPLAN)을 만들어 활성 맵으로 지정하면 지도에 반영됩니다.` })
    control.saveMap(mapName)
    clearMappingComplete()
  }, [mappingComplete, control, clearMappingComplete])

  const onStart = () => {
    setConfirming(false)
    setMsg(null)
    clearMappingComplete()
    control.startMapping()
    setRequested(true)
  }

  const onStopMapping = () => {
    control.stopMapping()
    setRequested(false)
    setMsg({ kind: 'warn', text: '매핑 중단을 요청했습니다. 로봇이 멈추면 진행 표시가 사라집니다.' })
  }

  const area = nav ? (nav.w * nav.res * nav.h * nav.res).toFixed(1) : null
  const offline = !enabled || !connected

  return (
    <fieldset className="lockfs" disabled={locked}>
      <div className="nav-stage">
        <aside className="nav-side" aria-label="매핑 제어">
          <div className="card-v3">
            <h3 style={{ margin: 0, marginBottom: '12px' }}>2D 맵 모델링 <span className="k">SLAM MAPPING</span></h3>
            {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없습니다. 실서버 모드로 로그인하면 진행 상황이 표시됩니다.</p>}
            {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}

            <div className="gotor">
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
                  onClick={onStopMapping}
                  disabled={offline}
                >
                  매핑 중단
                </button>
              )}
            </div>

            {phase === 'requested' && (
              <div className="mapstat wait" id="mapPhase">
                <i /> 시작 명령을 보냈습니다 — 로봇이 매핑에 들어가면 여기에 진행 상황이 표시됩니다.
              </div>
            )}
            {phase === 'running' && (
              <div className="mapstat run" id="mapPhase">
                <i /> 매핑 진행 중 — 로봇이 자율 주행하며 맵을 넓히고 있습니다.
              </div>
            )}
            {phase === 'complete' && (
              <div className="mapstat done" id="mapPhase">
                <i /> <b>매핑 완료 — 자동으로 저장합니다.</b> 서버가 정제 도면(FLOORPLAN)을 만들어 활성 맵으로 지정하면 지도에 반영됩니다.
              </div>
            )}

            {enabled && connected && !nav && phase === 'idle' && (
              <p className="cfg-help">아직 맵을 받지 못했습니다. 로봇의 라이다·SLAM 노드가 올라오면 여기에 진행 상황이 뜹니다.</p>
            )}
            {nav && (
              <div className="cfg-note">
                <div className="kv"><span>갱신 번호</span><b className="num">#{nav.seq}</b></div>
                <div className="kv"><span>격자</span><b className="num">{nav.w} × {nav.h}</b></div>
                <div className="kv"><span>해상도</span><b className="num">{nav.res} m/셀</b></div>
                <div className="kv"><span>포함 면적</span><b className="num">{area} m²</b></div>
                <div className="kv"><span>원점</span><b className="num">{nav.ox}, {nav.oy} m</b></div>
              </div>
            )}

            {msg && <div className={`form-msg ${msg.kind}`} id="mapMsg">{msg.text}</div>}
          </div>
        </aside>

        <div className="nav-canvas">
          <RoutePanel inspection={{
            candidates: inspection.candidates,
            points: inspection.points,
            selectedId: null,
          }} />
        </div>
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
