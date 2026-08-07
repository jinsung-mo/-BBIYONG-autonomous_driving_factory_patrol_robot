import { errMessage } from '../../live/errors.ts'
import { ROBOT_ID } from '../../live/config.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import LiveNavMap from '../robot/LiveNavMap.tsx'
import {
  addWaypoint, applyWaypoints, deleteWaypoint, listWaypoints, replaceWaypoints,
  startPatrol, startPatrolMessage, wpLabel,
} from '../../live/waypoints.ts'
import { useResourceSync } from '../../live/sync.ts'

// 순찰 경로 (S15P11E101-514) — 2D 지도를 클릭해 순찰 지점을 찍고, 순서를 정해 로봇에 하달한다.
//
// 운영 탭에 둔다. 맵을 만들고(모델링) 그 위에 경로를 그리고 로봇에 내려보내는 흐름이
// 한 화면에서 이어진다. 관제 화면은 모니터링과 실시간 개입만 맡는다(S15P11E101-475).
export default function RoutePanel({ inspection = null }: { inspection?: any } = {}) {
  const { enabled, connected, mapping } = useLive()
  const { accessToken } = useAuth()

  const [route, setRoute] = useState<import('../../live/contracts.d.ts').Waypoint[]>([])      // 화면에서 편집 중인 목록
  const [saved, setSaved] = useState<import('../../live/contracts.d.ts').Waypoint[]>([])      // 마지막으로 서버에서 받은 목록
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)        // { kind: ok|warn|err, text }

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

  // 지점 방향(heading) 설정 (S15P11E101-790). 로봇이 그 지점에서 바라볼 방향이다 —
  // 분전반을 '지나가는' 게 아니라 '바라보고' 점검하려면 필요하다.
  // 화면은 도(0~359, 0°=동쪽 +x · 90°=북쪽 +y)로 다루고 저장은 radians 다.
  // 비우면(yaw=null) 로봇이 가까운 구조물(벽/분전반)을 자동으로 바라본다(로봇 auto-yaw).
  const DEG = 180 / Math.PI
  const headingDeg = (w: any) => (w.yaw == null || !Number.isFinite(Number(w.yaw))
    ? '' : String(Math.round(((Number(w.yaw) * DEG) % 360 + 360) % 360)))
  const setHeading = (i: any, degText: string) => setRoute((prev) => prev.map((w, k) => {
    if (k !== i) return w
    const t = degText.trim()
    if (t === '') return { ...w, yaw: null }
    const deg = Number(t)
    if (!Number.isFinite(deg)) return w
    return { ...w, yaw: (((deg % 360) + 360) % 360) / DEG }
  }))
  const clearHeading = (i: any) => setRoute((prev) => prev.map((w, k) => (k === i ? { ...w, yaw: null } : w)))

  // 지도에서 지점을 눌러 드래그해 방향을 정한다(S15P11E101-797). 도(degree) 입력칸과
  // 같은 값(route[i].yaw, radians)을 쓴다 — 어느 쪽으로 정해도 서로 바로 반영된다.
  const onSetHeading = (i: number, yawRadians: number) =>
    setRoute((prev) => prev.map((w, k) => (k === i ? { ...w, yaw: yawRadians } : w)))

  // yaw 도 변경 감지에 넣는다 — 방향만 바꾸고 저장을 안 누르면 서버에 안 남는다.
  const key = (w: any) => [w.x, w.y, w.name || '', w.yaw == null ? 'auto' : Number(w.yaw).toFixed(4)]
  const dirty = JSON.stringify(route.map(key)) !== JSON.stringify(saved.map(key))
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  // 다른 접속자가 경로를 바꾸면 서버가 /topic/sync 로 알린다 — 새로고침 없이 따라간다.
  // 내가 고치는 중(dirty)이면 편집본은 두고 서버본(saved)만 갱신한다. 남의 변경이
  // 입력 중인 목록을 갈아치우면 찍던 지점을 잃는다 — '경로 저장 *' 표시가 충돌을 알린다.
  const refresh = useCallback(async () => {
    if (!enabled || !accessToken) return
    try {
      const rows = await listWaypoints(accessToken)
      if (!alive.current) return
      setSaved(rows)
      setRoute((prev) => (dirtyRef.current ? prev : rows))
    } catch {
      // 사용자가 시작한 동작이 아니다 — 다음 알림이나 '다시 불러오기' 가 길이다
    }
  }, [enabled, accessToken])
  useResourceSync('patrol-route', refresh)

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

  // 경로 적용 — 로봇에 보내기만 한다. 순찰은 시작되지 않는다(로봇 계약상 SET_PATROL_ROUTE
  // 만으로는 돌지 않는다). 경로만 갈아 끼우고 지금은 돌리고 싶지 않을 때 쓴다.
  const onApply = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await applyWaypoints(accessToken, ROBOT_ID)
      if (!alive.current) return
      // 로봇이 꺼져 있어도 200 이 온다 — delivered 로 구분해 알린다(저장은 이미 끝났다).
      setMsg(r?.delivered
        ? { kind: 'ok', text: `순찰 경로 ${r.count ?? route.length}개 지점을 로봇에 적용했습니다. 순찰은 아직 시작되지 않았습니다.` }
        : { kind: 'warn', text: '경로는 서버에 저장돼 있지만 로봇에 전달되지 않았습니다 — 로봇이 연결되면 다시 적용하세요.' })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `적용하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  // 순찰 시작 — 반드시 /start 로 한다(S15P11E101-625).
  // 로봇이 경로에 저장맵 세션 ID 를 stamp 하므로, 활성 맵이 바뀐 뒤 예전 경로로 autonomy 를
  // 요청하면 거절된다. 경로 재하달과 시작이 한 요청 안에서 붙어 나가야 세션이 맞는다.
  const onStart = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await startPatrol(accessToken, ROBOT_ID)
      if (!alive.current) return
      setMsg(startPatrolMessage(r))
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `순찰을 시작하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  const offline = !enabled || !connected
  // 매핑 중에는 경로를 건드리지 못하게 잠근다(S15P11E101-763).
  // 지금 그리는 지도는 옛 지도와 좌표가 다르다 — 그 위에 옛 지점을 얹으면 엉뚱한 자리를
  // 가리키고, 그대로 순찰을 시작하면 로봇이 없는 길로 간다.
  // 서버에 저장된 경로는 지우지 않는다. 매핑이 끝나고 다시 판단할 자산이다.
  const editLocked = offline || mapping

  return (
    <div className="card-v3" id="pgRoute">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>순찰 경로 <span className="k">PATROL ROUTE</span></h3>
      {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없어 지점을 찍을 수 없습니다. 실서버 모드로 로그인하세요.</p>}
      {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}
      {enabled && (
        <p className="cfg-help">
          지도를 클릭하면 그 자리에 순찰 지점이 추가됩니다. <b>지점을 누른 채 바라볼 방향으로
          끌면</b> 그 지점의 방향이 정해집니다(분전반을 바라보게 하고 싶을 때). 순서를 정한 뒤
          <b>경로 저장</b>으로 서버에 남기고, <b>순찰 시작</b>을 누르면 로봇이 그 경로로 돕니다.
          <b>경로 적용</b>은 로봇에 경로만 보내고 순찰은 시작하지 않습니다.
        </p>
      )}

      <div className="vwrap routemap">
        {/* 매핑 중에는 옛 지점 오버레이를 걷고 원본 격자만 보여 준다 */}
        <LiveNavMap
          route={mapping ? null : route}
          onPick={editLocked ? null : onPick}
          onSetHeading={editLocked ? null : onSetHeading}
          mapping={mapping}
          inspection={mapping ? null : inspection}
          follow={mapping}
        />
        {mapping && (
          <div className="routemap-note" role="status">
            지도를 새로 그리는 중입니다 — 기존 순찰 지점은 잠시 숨겼습니다.
            <span>저장된 경로는 지워지지 않습니다. 매핑이 끝나면 다시 보입니다.</span>
          </div>
        )}
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
              placeholder={`지점 ${i + 1}`} disabled={editLocked || busy}
              aria-label={`${i + 1}번 지점 이름`}
            />
            <span className="t mono">{Number(w.x).toFixed(2)}, {Number(w.y).toFixed(2)} m</span>
            {/* 방향(heading) — 로봇이 이 지점에서 바라볼 각도(S15P11E101-790).
                비우면 '자동': 로봇이 가까운 구조물(분전반/벽)을 스스로 바라본다. */}
            <input
              type="number" min={0} max={359} inputMode="numeric"
              className="wp-heading" value={headingDeg(w)}
              onChange={(e) => setHeading(i, e.target.value)}
              placeholder="자동" disabled={editLocked || busy}
              title="로봇이 이 지점에서 바라볼 방향(도, 0=동·90=북). 비우면 가까운 분전반/벽을 자동으로 바라봅니다."
              aria-label={`${i + 1}번 지점 방향(도)`}
              style={{ width: '58px' }}
            />
            <span className="t" style={{ opacity: 0.7, minWidth: '30px' }}>
              {w.yaw == null ? '자동' : '°'}
            </span>
            {w.yaw != null && (
              <button type="button" className="btn-tonal" onClick={() => clearHeading(i)} disabled={editLocked || busy} aria-label="방향 자동으로" title="방향 자동(가까운 벽 바라보기)" style={{ padding: '4px 8px' }}>자동</button>
            )}
            <button type="button" className="btn-tonal" onClick={() => move(i, -1)} disabled={editLocked || busy || i === 0} aria-label="위로" style={{ padding: '4px 8px' }}>↑</button>
            <button type="button" className="btn-tonal" onClick={() => move(i, 1)} disabled={editLocked || busy || i === route.length - 1} aria-label="아래로" style={{ padding: '4px 8px' }}>↓</button>
            <button type="button" className="btn-tonal" onClick={() => onDelete(w, i)} disabled={editLocked || busy} aria-label="삭제" style={{ color: '#B4655C', padding: '4px 8px' }}>삭제</button>
          </li>
        ))}
      </ul>

      <div className="gotor">
        <button type="button" className="btn-text" onClick={load} disabled={editLocked || busy}>다시 불러오기</button>
        <button type="button" id="btnSaveRoute" className="btn-tonal" onClick={onSave} disabled={editLocked || busy || !route.length || !dirty}>
          경로 저장{dirty ? ' *' : ''}
        </button>
        <button type="button" id="btnApplyRoute" className="btn-tonal" onClick={onApply} disabled={editLocked || busy || !route.length}>
          경로 적용
        </button>
        {/* 시작은 눈에 띄게 둔다 — 로봇이 실제로 움직이기 시작하는 버튼이다 */}
        <button type="button" id="btnStartPatrol" className="btn-filled" onClick={onStart} disabled={editLocked || busy || !route.length}>
          순찰 시작
        </button>
      </div>
      {dirty && <div className="cfg-note">순서·이름이 바뀌었습니다. <b>경로 저장</b>을 눌러야 서버에 반영됩니다.</div>}
    </div>
  )
}
