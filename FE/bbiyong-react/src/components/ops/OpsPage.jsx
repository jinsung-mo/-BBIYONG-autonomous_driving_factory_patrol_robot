import { useCallback, useEffect, useState } from 'react'
import { useLive } from '../../live/LiveContext.jsx'
import { useAuth } from '../../auth/AuthContext.jsx'
import { authedGet } from '../../live/authApi.js'
import { ROBOT_ID } from '../../live/config.js'

// 운영 (S15P11E101-475) — 2D 맵 모델링과 저장된 맵 관리. 관리자만 들어온다.
export default function OpsPage() {
  const { enabled, connected, control, onNavUpdate } = useLive()
  const { accessToken } = useAuth()

  const [nav, setNav] = useState(null)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(null)   // 발행한 SAVE_MAP 이름
  const [maps, setMaps] = useState([])
  const [mapsErr, setMapsErr] = useState(null)
  const [loading, setLoading] = useState(false)

  // 실시간 맵 진행 상황 — /topic/nav 의 MAP 스냅샷을 그대로 본다
  useEffect(() => onNavUpdate((n) => setNav(n?.map ? { ...n.map } : null)), [onNavUpdate])

  const loadMaps = useCallback(async () => {
    if (!enabled || !accessToken) return
    setLoading(true); setMapsErr(null)
    try {
      const res = await authedGet('/api/maps', accessToken)
      setMaps(Array.isArray(res) ? res : (res?.content || []))
    } catch (e) { setMapsErr(e.message) } finally { setLoading(false) }
  }, [enabled, accessToken])

  useEffect(() => { loadMaps() }, [loadMaps])

  const onSave = () => {
    const n = name.trim()
    if (!n) return
    control.saveMap(n)
    setSaved(n)
    setName('')
  }

  const area = nav ? (nav.w * nav.res * nav.h * nav.res).toFixed(1) : null

  return (
    <section id="pgOps" className="page on section-page">
      <div className="cfg-grid">
        <div className="panel">
          <h3>2D 맵 모델링 <span className="k">SLAM MAPPING</span></h3>
          {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없습니다. 실서버 모드로 로그인하면 진행 상황이 표시됩니다.</p>}
          {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}
          {enabled && connected && !nav && (
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
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="저장할 맵 이름 (예: factory_01)"
              disabled={!enabled || !connected}
            />
            <button type="button" className="dbtn go" onClick={onSave} disabled={!enabled || !connected || !name.trim() || !nav}>
              이 맵 사용
            </button>
          </div>
          {saved && <div className="form-msg ok">`{saved}` 저장 명령을 보냈습니다 — 로봇이 처리한 뒤 아래 목록에 나타납니다.</div>}
          <div className="cfg-note">
            <b>자율 탐색 시작·중지는 아직 붙이지 않았습니다.</b> 로봇 명령 계약에 해당 명령이 없습니다
            (가이드 §5의 mode 는 autonomy · manual · disabled 뿐). 로봇 파트에서 명령이 정해지면 이 자리에 붙입니다.
            지금은 로봇이 탐색하는 동안 위 진행 상황을 보고, 완료 시점에 이름을 붙여 저장하는 흐름입니다.
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
                  <li key={m.id ?? m.mapId ?? i}>
                    <b>{m.name || m.mapId || m.id}</b>
                    <span className="t mono">
                      {m.widthPx && m.heightPx ? `${m.widthPx}×${m.heightPx}` : ''}
                      {m.resolution ? ` · ${m.resolution} m/px` : ''}
                    </span>
                    {i === 0 && <span className="tag">활성</span>}
                  </li>
                ))}
              </ul>
              <div className="cfg-note">
                활성 맵은 <b className="mono">GET /api/maps/latest</b> 가 돌려주는 최신 맵입니다.
                임의 지정 API 가 아직 없어 목록 맨 위(최신)를 활성으로 표시합니다 — BE 확인 후 연결하겠습니다.
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
