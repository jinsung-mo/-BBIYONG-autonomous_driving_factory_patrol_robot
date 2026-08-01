import { errMessage } from '../../live/errors.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { ROBOT_ID } from '../../live/config.ts'
import Modal from '../ui/Modal.tsx'
import RoutePanel from './RoutePanel.tsx'
import {
  MAPPING_STATUS, activateMap, activatePath, activeMapIdOf, fetchMaps, mapIdOf, mapNameOf,
  waitForSavedMap, NotImplementedError,
} from '../../live/mapping.ts'

// 운영 (S15P11E101-475) — 2D 맵 모델링과 저장된 맵 관리. 관리자만 들어온다.
// 맵 모델링 시작·진행·완료·저장(활성화) 전 과정은 S15P11E101-483.
export default function OpsPage() {
  const { enabled, connected, control, onNavUpdate, telemetry, mappingComplete, clearMappingComplete } = useLive()
  const { accessToken } = useAuth()

  const [nav, setNav] = useState<import('../../live/contracts.d.ts').DecodedMap | null>(null)
  const [name, setName] = useState('')
  const [maps, setMaps] = useState<import('../../live/contracts.d.ts').MapSummary[]>([])
  const [mapsErr, setMapsErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [confirming, setConfirming] = useState(false)
  const [requested, setRequested] = useState(false)   // START_MAPPING 발행 후 로봇 반응 대기
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)                // { kind: ok|warn|err, text }

  // 언마운트 뒤 setState 를 막는다 — 저장 흐름은 최대 12초까지 폴링한다
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

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

  // 진행 단계. 완료 이벤트 > 로봇이 보고하는 MAPPING > 발행 직후 대기 순으로 우선한다.
  const running = telemetry?.status === MAPPING_STATUS
  const phase = mappingComplete ? 'complete' : (running ? 'running' : (requested ? 'requested' : 'idle'))

  // 로봇이 매핑에 들어갔거나 끝났으면 '대기 중' 딱지는 역할이 끝났다
  useEffect(() => { if (running || mappingComplete) setRequested(false) }, [running, mappingComplete])

  // 완료 이벤트는 로봇이 붙인 맵 이름을 함께 보낸다(EVENT_MAPPING_COMPLETE { robot_id, name }).
  // 비어 있을 때만 채운다 — 사용자가 입력하던 이름을 덮어쓰지 않는다.
  useEffect(() => {
    const suggested = mappingComplete?.name
    if (suggested) setName((prev) => (prev.trim() ? prev : suggested))
  }, [mappingComplete])

  const onStart = () => {
    setConfirming(false)
    setMsg(null)
    clearMappingComplete()
    control.startMapping()
    setRequested(true)
  }

  // 'SAVE_MAP 발행 → 로봇 업로드 대기 → 활성 맵 지정' 한 흐름.
  // SAVE_MAP 은 STOMP 라 응답이 없으므로 이름으로 목록에서 되찾아 id 를 얻는다.
  const onSave = async () => {
    const n = name.trim()
    if (!n || saving) return
    setSaving(true)
    setMsg({ kind: 'ok', text: `'${n}' 저장 명령(SAVE_MAP)을 보냈습니다. 로봇이 업로드하면 활성 맵으로 지정합니다…` })
    control.saveMap(n)

    const found = await waitForSavedMap(n, accessToken, { signal: { get aborted() { return !alive.current } } })
    if (!alive.current) return
    if (!found) {
      setMsg({
        kind: 'warn',
        text: `'${n}' 저장 명령은 보냈지만 아직 맵 목록에 나타나지 않았습니다. 로봇이 업로드를 끝낸 뒤 아래 '목록 새로고침'으로 확인하세요.`,
      })
      setSaving(false)
      return
    }

    try {
      await activateMap(mapIdOf(found), accessToken)
      if (!alive.current) return
      setMsg({ kind: 'ok', text: `'${n}' 을(를) 저장하고 활성 맵으로 지정했습니다.` })
      setName('')
      clearMappingComplete()
    } catch (e) {
      if (!alive.current) return
      if (e instanceof NotImplementedError) {
        setMsg({
          kind: 'warn',
          text: `'${n}' 은 저장됐지만 활성 맵 지정 API 가 서버에 아직 없습니다 (${activatePath('{id}')}). `
            + 'BE 에 추가되면 이 화면 수정 없이 바로 동작합니다. 그때까지는 최신 맵이 활성입니다.',
        })
      } else {
        setMsg({ kind: 'err', text: `활성 맵 지정에 실패했습니다 — ${errMessage(e)}` })
      }
    }
    setSaving(false)
    loadMaps()
  }

  const area = nav ? (nav.w * nav.res * nav.h * nav.res).toFixed(1) : null
  const offline = !enabled || !connected
  const activeId = activeMapIdOf(maps)

  return (
    <section id="pgOps" className="page on section-page">
      <div className="cfg-grid">
        <div className="panel">
          <h3>2D 맵 모델링 <span className="k">SLAM MAPPING</span></h3>
          {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없습니다. 실서버 모드로 로그인하면 진행 상황이 표시됩니다.</p>}
          {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}

          {/* 시작 — 확인을 한 번 받는다. 로봇이 순찰을 멈추고 공장 전체를 돌기 시작하는 명령이다. */}
          <div className="gotor">
            <button
              type="button" id="btnStartMapping" className="dbtn go"
              onClick={() => setConfirming(true)}
              disabled={offline || phase === 'running' || phase === 'requested'}
            >
              {phase === 'running' ? '매핑 진행 중…' : '맵 모델링 시작'}
            </button>
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
              <i /> <b>매핑 완료 — 이 맵을 사용할까요?</b> 아래에 이름을 입력하고 <b>이 맵 사용</b>을 누르면 저장 후 활성 맵으로 지정합니다.
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

          <div className="gotor">
            <input
              id="mapName" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="저장할 맵 이름 (예: factory_01)"
              disabled={offline || saving}
            />
            <button
              type="button" id="btnUseMap" className="dbtn go" onClick={onSave}
              disabled={offline || saving || !name.trim() || !nav}
            >
              {saving ? '저장 중…' : '이 맵 사용'}
            </button>
          </div>
          {msg && <div className={`form-msg ${msg.kind}`} id="mapMsg">{msg.text}</div>}

          <div className="cfg-note">
            <b>로봇 파트 구현 대기 중입니다.</b> 시작 명령(START_MAPPING)은 서버가 로봇으로 전달하지만,
            로봇 브리지가 아직 이 명령과 완료 이벤트를 처리하지 않습니다. 로봇 쪽이 올라오면 이 화면 수정 없이 그대로 동작합니다.
          </div>
        </div>

        <div className="panel">
          <h3>저장된 맵 <span className="k">ARCHIVE</span></h3>
          <p className="cfg-help">로봇 <b className="mono">{ROBOT_ID}</b> 의 저장 맵 목록입니다.</p>
          {!enabled && <div className="cfg-note">실서버 모드에서만 조회됩니다.</div>}
          {enabled && (
            <>
              <button type="button" className="dbtn" onClick={loadMaps} disabled={loading}>
                {loading ? '불러오는 중…' : '목록 새로고침'}
              </button>
              {mapsErr && <div className="form-msg err">맵 목록을 불러오지 못했습니다 — {mapsErr}</div>}
              {!mapsErr && maps.length === 0 && !loading && (
                <div className="cfg-note">저장된 맵이 없습니다. 위에서 현재 맵을 저장하면 여기에 쌓입니다.</div>
              )}
              <ul className="map-list">
                {maps.map((m, i) => (
                  <li key={mapIdOf(m) ?? i}>
                    <b>{mapNameOf(m) || mapIdOf(m)}</b>
                    <span className="t mono">
                      {m.kind ? `${m.kind === 'FLOORPLAN' ? '도면' : '원본'} · ` : ''}
                      {m.widthPx && m.heightPx ? `${m.widthPx}×${m.heightPx}` : ''}
                      {m.resolution ? ` · ${m.resolution} m/px` : ''}
                    </span>
                    {mapIdOf(m) === activeId && <span className="tag">활성</span>}
                  </li>
                ))}
              </ul>
              <div className="cfg-note">
                <b>이 맵 사용</b>을 누르면 저장 후 <b className="mono">PUT {activatePath('{id}')}</b> 로 활성 맵을 지정합니다.
                매핑이 끝나면 서버가 정제 도면(<b className="mono">FLOORPLAN</b>)을 만들어 활성화하고, 관제 지도에 자동으로 표시됩니다.
              </div>
            </>
          )}
        </div>
      </div>

      {/* 맵을 만든 뒤 그 위에 순찰 경로를 그리는 흐름이라 같은 탭에 둔다(S15P11E101-514) */}
      <RoutePanel />

      {confirming && (
        <Modal title="맵 모델링을 시작할까요?" onClose={() => setConfirming(false)} width={420}>
          <p className="cfg-help" style={{ marginBottom: 12 }}>
            로봇이 <b>순찰을 멈추고</b> 공장 안을 자율 주행하며 새 2D 맵을 만듭니다.
            주행 경로에 사람이나 장애물이 없는지 확인한 뒤 시작하세요.
          </p>
          <div className="gotor">
            <button type="button" className="dbtn" onClick={() => setConfirming(false)}>취소</button>
            <button type="button" id="btnStartMappingOk" className="dbtn go" onClick={onStart}>시작</button>
          </div>
        </Modal>
      )}
    </section>
  )
}
