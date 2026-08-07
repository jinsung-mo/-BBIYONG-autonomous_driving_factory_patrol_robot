import { errMessage } from '../../live/errors.ts'
import { displayName } from '../../live/robotName.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { ROBOT_ID } from '../../live/config.ts'
import Modal from '../ui/Modal.tsx'
import InspectionPanel from './InspectionPanel.tsx'
import RoutePanel from './RoutePanel.tsx'
import SchedulePanel from './SchedulePanel.tsx'
// 분전반 임계온도 관리(S15P11E101-836). 설정탭에 있던 설비 현황을 운영탭으로 옮기고
// 임계온도 편집을 붙였다 — 삐용봇이 분전반을 탐지하면 여기서 과열 기준을 정한다.
import EquipmentPanel from '../config/EquipmentPanel.tsx'
import KpiRow from '../robot/KpiRow.tsx'
import { useInspection } from '../../live/inspection.ts'
import { useResourceSync } from '../../live/sync.ts'
import {
  MAPPING_STATUS, activeMapIdOf, fetchMaps, mapIdOf, mapNameOf,
  loadMapImageUrl, releaseMapImageUrl,
} from '../../live/mapping.ts'

// 운영 (S15P11E101-475) — 2D 맵 모델링과 저장된 맵 관리. 관리자만 들어온다.
// 맵 모델링 시작·진행·완료·저장(활성화) 전 과정은 S15P11E101-483.
export default function OpsPage() {
  // 점검 지점(S15P11E101-787). 패널과 지도가 같은 값을 봐야 한다 —
  // 각자 구독하면 승인한 순간 목록과 지도가 잠깐 어긋난다.
  const inspection = useInspection()
  // 지도에서 어느 점을 강조할지. 목록에 손을 올린 것만으로 지도에서 찾을 수 있어야 한다.
  const [inspSel, setInspSel] = useState<string | null>(null)
  const { enabled, connected, control, onNavUpdate, telemetry, mapping, mappingComplete, clearMappingComplete } = useLive()
  const { accessToken, locked } = useAuth()

  const [nav, setNav] = useState<import('../../live/contracts.d.ts').DecodedMap | null>(null)
  const [maps, setMaps] = useState<import('../../live/contracts.d.ts').MapSummary[]>([])
  const [mapsErr, setMapsErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [confirming, setConfirming] = useState(false)
  const [requested, setRequested] = useState(false)   // START_MAPPING 발행 후 로봇 반응 대기
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)                // { kind: ok|warn|err, text }
  // 매핑 완료를 이미 저장했는지. 완료 이벤트가 재렌더로 여러 번 읽혀도 SAVE_MAP 을 한 번만 보낸다.
  const savedRef = useRef(false)

  // 저장 맵 이미지 미리보기 팝업(S15P11E101-791). 제목이나 '맵 보기' 를 눌러 크게 본다.
  const [preview, setPreview] = useState<{ url: string, name: string } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  // 언마운트 뒤 setState 를 막는다 — 저장 흐름은 최대 12초까지 폴링한다
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  // 미리보기 objectURL 은 닫을 때 반드시 돌려준다 — 안 그러면 열 때마다 blob 이 쌓인다
  useEffect(() => () => releaseMapImageUrl(preview?.url), [preview])

  // 저장된 맵 제목 클릭 — 도면 이미지를 팝업으로 크게 본다(S15P11E101-791).
  const openPreview = async (m: any) => {
    if (previewBusy || !m?.imageUrl) return
    setPreviewBusy(true); setMsg(null)
    try {
      const url = await loadMapImageUrl(m.imageUrl, accessToken)
      if (!alive.current) { releaseMapImageUrl(url); return }
      setPreview((prev) => { releaseMapImageUrl(prev?.url); return { url, name: mapNameOf(m) || mapIdOf(m) } })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `맵 이미지를 열지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setPreviewBusy(false) }
  }
  const closePreview = () => setPreview((prev) => { releaseMapImageUrl(prev?.url); return null })

  // 실시간 맵 진행 상황 — /topic/nav 의 MAP 스냅샷을 그대로 본다
  useEffect(() => onNavUpdate((n: any) => setNav(n?.map ? { ...n.map } : null)), [onNavUpdate])

  const loadMaps = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true); setMapsErr(null)
    try {
      setMaps(await fetchMaps(accessToken))
    } catch (e) { setMapsErr(errMessage(e)) } finally { setLoading(false) }
  }, [enabled, accessToken])

  useEffect(() => { loadMaps() }, [loadMaps])

  // 다른 접속자가 매핑을 저장하거나 서버가 도면을 만들면 목록이 바뀐다 —
  // /topic/sync 알림으로 새로고침 없이 따라간다.
  useResourceSync('maps', loadMaps)

  // kind 가 없는 옛 레코드는 원본으로 본다 — 도면이라고 단정하면 목록에 섞여 들어온다.
  const isPlan = (m: any) => String(m?.kind || '').toUpperCase() === 'FLOORPLAN'
  const sourceNameOf = (m: any) => {
    const src = m?.sourceMapId
    if (!src) return null
    const hit = maps.find((x: any) => mapIdOf(x) === src)
    return hit ? (mapNameOf(hit) || src) : src
  }
  const planCount = maps.filter(isPlan).length
  // 목록은 도면(FLOORPLAN)만 보여 준다. 원본(RAW)은 도면 생성 재료일 뿐 사람이 볼 일이
  // 없어 노출을 접었다 — '원본 보기' 토글과 원본 행 표기를 함께 걷어냈다(2026-08-07 결정).
  const shownMaps = maps.filter(isPlan)

  // 진행 단계. 완료 이벤트 > 로봇이 보고하는 MAPPING > 발행 직후 대기 순으로 우선한다.
  //
  // '요청함' 과 '실제로 매핑 중' 을 끝까지 구분한다(S15P11E101-763). START_MAPPING 은
  // 발행만 하고 응답이 없어, 로봇이 거부해도 FE 는 모른다 — 요청만으로 라이브 지도를
  // 열면 영영 채워지지 않는 빈 화면이 남는다. 라이브 화면은 mapping 이 true 일 때만 연다.
  const running = mapping || telemetry?.status === MAPPING_STATUS
  const phase = mappingComplete ? 'complete' : (running ? 'running' : (requested ? 'requested' : 'idle'))

  // 로봇이 매핑에 들어갔거나 끝났으면 '대기 중' 딱지는 역할이 끝났다
  useEffect(() => { if (running || mappingComplete) setRequested(false) }, [running, mappingComplete])

  // 매핑 완료 시 자동 저장(S15P11E101-836).
  //
  // 예전에는 이름을 입력하고 '이 맵 사용' 을 눌러야 저장됐다. 그 수동 단계를 없앤다 —
  // 완료 이벤트(EVENT_MAPPING_COMPLETE { robot_id, name })가 오면 로봇이 붙인 이름으로,
  // 없으면 시각 기반 기본 이름으로 곧장 SAVE_MAP 을 보낸다. 서버가 정제 도면(FLOORPLAN)을
  // 만들어 활성 맵으로 지정하면 지도에 자동으로 반영된다.
  useEffect(() => {
    if (!mappingComplete) { savedRef.current = false; return }  // 다음 매핑을 위해 리셋
    if (savedRef.current) return
    savedRef.current = true
    const suggested = (mappingComplete.name || '').trim()
    const mapName = suggested
      || `map_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
    setMsg({ kind: 'ok', text: `매핑 완료 — '${mapName}' 이름으로 자동 저장합니다. 서버가 정제 도면(FLOORPLAN)을 만들어 활성 맵으로 지정하면 지도에 반영됩니다.` })
    control.saveMap(mapName)
    clearMappingComplete()
    setTimeout(loadMaps, 1000)
  }, [mappingComplete, control, clearMappingComplete, loadMaps])

  const onStart = () => {
    setConfirming(false)
    setMsg(null)
    clearMappingComplete()
    control.startMapping()
    setRequested(true)
  }

  // 매핑 중단(S15P11E101-627). 로봇이 공장을 돌고 있는 중이라 되돌릴 수 있어야 한다 —
  // 지금까지는 시작만 있고 멈출 방법이 화면에 없었다.
  // 여기까지 만든 맵은 로봇에 남으므로, 다시 시작하면 이어서가 아니라 처음부터다.
  const onStopMapping = () => {
    control.stopMapping()
    setRequested(false)
    setMsg({ kind: 'warn', text: '매핑 중단을 요청했습니다. 로봇이 멈추면 진행 표시가 사라집니다.' })
  }

  const area = nav ? (nav.w * nav.res * nav.h * nav.res).toFixed(1) : null
  const offline = !enabled || !connected
  const activeId = activeMapIdOf(maps)

  return (
    <section id="pgOps" className="page on v3-theme nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>운영 관리</h2>
          <span className="nav-sub">SLAM MAPPING · ROUTE · SCHEDULE</span>
        </div>
        <KpiRow />
      </div>
      {/* 잠금 중에는 운영 조작을 막는다(S15P11E101-653) — 진행 상황은 계속 보인다.
          fieldset[disabled] 을 쓰는 이유: 조작 요소를 하나씩 막으면 반드시 빠진다.
          안쪽 폼 요소를 전부, 키보드 접근까지 막아 준다. */}
      <fieldset className="lockfs" disabled={locked}>
        <div className="nav-stage">
          <aside className="nav-side" aria-label="운영 요약 및 매핑 제어">
            <div className="card-v3">
              <h3 style={{ margin: 0, marginBottom: '12px' }}>2D 맵 모델링 <span className="k">SLAM MAPPING</span></h3>
              {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없습니다. 실서버 모드로 로그인하면 진행 상황이 표시됩니다.</p>}
              {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}

              {/* 시작 — 확인을 한 번 받는다. 로봇이 순찰을 멈추고 공장 전체를 돌기 시작하는 명령이다. */}
              <div className="gotor">
                <button
                  type="button" id="btnStartMapping" className="btn-filled"
                  onClick={() => setConfirming(true)}
                  disabled={offline || phase === 'running' || phase === 'requested'}
                >
                  {phase === 'running' ? '매핑 진행 중…' : '맵 모델링 시작'}
                </button>
                {/* 돌고 있을 때만 멈출 것이 있다 */}
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

              {/* 진행 표시 */}
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

            <InspectionPanel
              candidates={inspection.candidates}
              points={inspection.points}
              onConfirm={(candidateId, cname) => {
                inspection.confirm(candidateId, cname)
                // 승인한 순간 그 지점을 지도에서 짚어 준다 — 후보가 확정 지점(번호 있는
                // 마름모)으로 바뀌므로, 같은 좌표의 확정 점 id(pt-<candidateId>)를 고른다.
                setInspSel(`pt-${candidateId}`)
              }}
              onReject={inspection.reject}
              onRename={inspection.rename}
              onToggle={inspection.setEnabled}
              onDelete={inspection.remove}
              onPublish={inspection.publishAll}
              selectedId={inspSel}
              onSelect={setInspSel}
            />

            {/* 분전반 임계온도(S15P11E101-836). 삐용봇이 탐지한 분전반의 과열 기준을 여기서 정한다. */}
            <EquipmentPanel />

            <div className="card-v3">
              <h3 style={{ margin: 0, marginBottom: '12px' }}>저장된 맵 <span className="k">ARCHIVE</span></h3>
              <p className="cfg-help">로봇 <b className="mono">{displayName(ROBOT_ID)}</b> 의 저장 맵 목록입니다.</p>
              {!enabled && <div className="cfg-note">실서버 모드에서만 조회됩니다.</div>}
              {enabled && (
                <>
                  <button type="button" className="btn-tonal" onClick={loadMaps} disabled={loading}>
                    {loading ? '불러오는 중…' : '목록 새로고침'}
                  </button>
                  {mapsErr && <div className="form-msg err">맵 목록을 불러오지 못했습니다 — {mapsErr}</div>}
                  {!mapsErr && maps.length === 0 && !loading && (
                    <div className="cfg-note">저장된 맵이 없습니다. 위에서 현재 맵을 저장하면 여기에 쌓입니다.</div>
                  )}
                  {/* 저장된 맵은 과거 기록을 '보는' 용도다(2026-08-07 결정). 예전의 '이 맵 사용'
                      (재활성화)은 걷어냈다 — 활성 맵은 매핑 완료 시 서버가 자동 지정한다. */}
                  <div className="maplist-head">
                    <span className="k mono">도면 {planCount}건</span>
                  </div>
                  <ul className="map-list">
                    {shownMaps.map((m, i) => (
                      <li key={mapIdOf(m) ?? i} className="plan">
                        {/* 제목을 누르면 도면 이미지를 팝업으로 크게 본다(S15P11E101-791) */}
                        <button
                          type="button" className="btn-text maptitle"
                          onClick={() => openPreview(m)} disabled={previewBusy || !m.imageUrl}
                          title="도면 이미지 크게 보기"
                          style={{ padding: 0, fontWeight: 700, textAlign: 'left', cursor: 'pointer' }}
                        >
                          {mapNameOf(m) || mapIdOf(m)}
                        </button>
                        <span className="t mono">
                          {m.widthPx && m.heightPx ? `${m.widthPx}×${m.heightPx}` : ''}
                          {m.resolution ? ` · ${m.resolution} m/px` : ''}
                        </span>
                        {/* 같은 매핑 세션의 원본에서 나왔음을 알려 준다 */}
                        {sourceNameOf(m) && (
                          <span className="t mono src">원본 {sourceNameOf(m)}</span>
                        )}
                        {mapIdOf(m) === activeId && <span className="tag">활성</span>}
                        <button
                          type="button" className="btn-tonal"
                          onClick={() => openPreview(m)}
                          disabled={previewBusy || !m.imageUrl}
                          title="이 맵의 도면 이미지를 크게 봅니다"
                          style={{ padding: '4px 8px', marginLeft: 'auto' }}
                        >
                          맵 보기
                        </button>
                      </li>
                    ))}
                    {!shownMaps.length && (
                      <li className="empty">
                        <span className="t">저장된 도면이 없습니다. 매핑을 마치면 여기에 쌓입니다.</span>
                      </li>
                    )}
                  </ul>
                  <div className="cfg-note">
                    제목이나 <b>맵 보기</b>를 누르면 과거 도면 이미지를 크게 볼 수 있습니다.
                    활성 맵은 매핑을 새로 마칠 때 서버가 정제 도면(<b className="mono">FLOORPLAN</b>)을 생성해 자동으로 지정합니다.
                  </div>
                </>
              )}
            </div>
          </aside>

          <div className="nav-canvas">
            <RoutePanel inspection={{
              candidates: inspection.candidates,
              points: inspection.points,
              selectedId: inspSel,
            }} />
            <SchedulePanel />
          </div>
        </div>
      </fieldset>

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

      {/* 저장 맵 도면 이미지 미리보기(S15P11E101-791) */}
      {preview && (
        <Modal title={`도면 미리보기 — ${preview.name}`} onClose={closePreview} width={720}>
          <img
            src={preview.url} alt={`${preview.name} 도면`}
            style={{ display: 'block', width: '100%', height: 'auto', background: '#fff', borderRadius: 8 }}
          />
        </Modal>
      )}
    </section>
  )
}
