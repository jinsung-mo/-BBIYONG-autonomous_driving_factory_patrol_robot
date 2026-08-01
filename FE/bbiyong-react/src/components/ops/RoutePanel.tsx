import { errMessage } from '../../live/errors.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import LiveNavMap from '../robot/LiveNavMap.tsx'
import {
  addWaypoint, applyWaypoints, deleteWaypoint, listWaypoints, replaceWaypoints, wpLabel,
} from '../../live/waypoints.ts'

// 순찰 경로 (S15P11E101-514) — 2D 지도를 클릭해 순찰 지점을 찍고, 순서를 정해 로봇에 하달한다.
//
// 운영 탭에 둔다. 맵을 만들고(모델링) 그 위에 경로를 그리고 로봇에 내려보내는 흐름이
// 한 화면에서 이어진다. 관제 화면은 모니터링과 실시간 개입만 맡는다(S15P11E101-475).
export default function RoutePanel() {
  const { enabled, connected } = useLive()
  const { accessToken } = useAuth()

  const [route, setRoute] = useState([])      // 화면에서 편집 중인 목록
  const [saved, setSaved] = useState([])      // 마지막으로 서버에서 받은 목록
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)        // { kind: ok|warn|err, text }

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    setBusy(true)
    try {
      const rows = await listWaypoints(accessToken)
      if (!alive.current) return
      setRoute(rows); setSaved(rows); setMsg(null)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `순찰 경로를 불러오지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  // 지도 클릭 — 서버에 바로 1건 추가한다(POST). 목록만 늘려 두면 새로고침에 사라진다.
  const onPick = async (p: any) => {
    if (!p) { setMsg({ kind: 'warn', text: '맵 바깥은 지정할 수 없습니다. 회색으로 칠해진 영역 안을 클릭하세요.' }); return }
    if (busy) return
    setBusy(true)
    try {
      const created = await addWaypoint({ ...p, seq: route.length + 1 }, accessToken)
      if (!alive.current) return
      const next = [...route, created]
      setRoute(next); setSaved(next)
      setMsg({ kind: 'ok', text: `지점 ${next.length} 추가 — x ${p.x} · y ${p.y} m` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `지점을 추가하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  const onDelete = async (w: any, i: any) => {
    if (busy) return
    setBusy(true)
    try {
      await deleteWaypoint(w.id, accessToken)
      if (!alive.current) return
      const next = route.filter((_, k) => k !== i)
      setRoute(next); setSaved(next)
      setMsg({ kind: 'ok', text: `${wpLabel(w, i)} 삭제` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `삭제하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  // 순서·이름은 화면에서만 바꾸고 '경로 저장'(PUT)으로 한 번에 반영한다.
  const move = (i: any, d: any) => {
    const j = i + d
    if (j < 0 || j >= route.length) return
    const next = route.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setRoute(next)
  }
  const rename = (i: any, name: any) => setRoute((prev) => prev.map((w, k) => (k === i ? { ...w, name } : w)))

  const dirty = JSON.stringify(route.map((w) => [w.x, w.y, w.name || '']))
    !== JSON.stringify(saved.map((w) => [w.x, w.y, w.name || '']))

  const onSave = async () => {
    if (busy) return
    setBusy(true)
    try {
      const rows = await replaceWaypoints(route, accessToken)
      if (!alive.current) return
      setRoute(rows); setSaved(rows)
      setMsg({ kind: 'ok', text: `순찰 경로 ${rows.length}개 지점을 저장했습니다.` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `저장하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  const onApply = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await applyWaypoints(accessToken)
      if (!alive.current) return
      // 로봇이 꺼져 있어도 200 이 온다 — delivered 로 구분해 알린다(저장은 이미 끝났다).
      setMsg(r?.delivered
        ? { kind: 'ok', text: `순찰 경로 ${r.count ?? route.length}개 지점을 로봇에 하달했습니다.` }
        : { kind: 'warn', text: '경로는 서버에 저장돼 있지만 로봇에 전달되지 않았습니다 — 로봇이 연결되면 다시 하달하세요.' })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `하달하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  const offline = !enabled || !connected

  return (
    <div className="panel" id="pgRoute">
      <h3>순찰 경로 <span className="k">PATROL ROUTE</span></h3>
      {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없어 지점을 찍을 수 없습니다. 실서버 모드로 로그인하세요.</p>}
      {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}
      {enabled && (
        <p className="cfg-help">
          지도를 클릭하면 그 자리에 순찰 지점이 추가됩니다. 순서를 정한 뒤 <b>경로 저장</b>,
          로봇에 반영하려면 <b>로봇에 하달</b>을 누르세요.
        </p>
      )}

      <div className="vwrap routemap">
        <LiveNavMap route={route} onPick={offline ? null : onPick} />
      </div>

      {msg && <div className={`form-msg ${msg.kind}`} id="routeMsg">{msg.text}</div>}

      {route.length === 0 && !busy && (
        <div className="cfg-note">아직 지정된 순찰 지점이 없습니다. 위 지도를 클릭해 첫 지점을 찍으세요.</div>
      )}

      <ul className="map-list" id="routeList">
        {route.map((w, i) => (
          <li key={w.id ?? i}>
            <span className="tag">{i + 1}</span>
            <input
              value={w.name || ''} onChange={(e) => rename(i, e.target.value)}
              placeholder={`지점 ${i + 1}`} disabled={offline || busy}
              aria-label={`${i + 1}번 지점 이름`}
            />
            <span className="t mono">{Number(w.x).toFixed(2)}, {Number(w.y).toFixed(2)} m</span>
            <button type="button" className="dbtn" onClick={() => move(i, -1)} disabled={offline || busy || i === 0} aria-label="위로">↑</button>
            <button type="button" className="dbtn" onClick={() => move(i, 1)} disabled={offline || busy || i === route.length - 1} aria-label="아래로">↓</button>
            <button type="button" className="dbtn" onClick={() => onDelete(w, i)} disabled={offline || busy} aria-label="삭제">삭제</button>
          </li>
        ))}
      </ul>

      <div className="gotor">
        <button type="button" className="dbtn" onClick={load} disabled={offline || busy}>다시 불러오기</button>
        <button type="button" id="btnSaveRoute" className="dbtn go" onClick={onSave} disabled={offline || busy || !route.length || !dirty}>
          경로 저장{dirty ? ' *' : ''}
        </button>
        <button type="button" id="btnApplyRoute" className="dbtn go" onClick={onApply} disabled={offline || busy || !route.length}>
          로봇에 하달
        </button>
      </div>
      {dirty && <div className="cfg-note">순서·이름이 바뀌었습니다. <b>경로 저장</b>을 눌러야 서버에 반영됩니다.</div>}
    </div>
  )
}
