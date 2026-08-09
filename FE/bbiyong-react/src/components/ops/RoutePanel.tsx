import { errMessage } from '../../live/errors.ts'
import { ROBOT_ID } from '../../live/config.ts'
import { playVoice } from '../../live/voice.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import LiveNavMap from '../robot/LiveNavMap.tsx'
import {
  addWaypoint, deleteWaypoint, listWaypoints, startPatrol, startPatrolMessage, wpLabel,
} from '../../live/waypoints.ts'
import { useResourceSync } from '../../live/sync.ts'

// 순찰 경로 (S15P11E101-514) — 2D 지도를 클릭해 순찰 지점을 찍고, 로봇에 하달한다.
//
// 운영 탭에 둔다. 맵을 만들고(모델링) 그 위에 경로를 그리고 로봇에 내려보내는 흐름이
// 한 화면에서 이어진다. 관제 화면은 모니터링과 실시간 개입만 맡는다(S15P11E101-475).
//
// 지점 이름·방향(heading)·순서 편집 UI 는 뗐다(S15P11E101-814) — 각 지점은 번호와 삭제만
// 남는다. 이름/방향은 여전히 서버 계약(WaypointRequest.name/yaw)에 있지만, 이 화면은 값을
// 보내지 않는다(undefined) — addWaypoint 가 두 필드를 이미 '있을 때만' 보내도록 돼 있어
// (조건부 스프레드) 그대로 두면 서버가 기본값(이름 없음 → wpLabel 이 '지점 N'으로 표시,
// 방향 없음 → 로봇 자동 응시)으로 채운다. 순서(seq)는 지점을 찍은 순서 그대로 간다 —
// 재정렬 UI(↑/↓)도 뗐으므로 addWaypoint 가 매번 '끝에 추가'로 보내는 seq 가 곧 최종 순서다.
// blockedBy → 화면 표시 폴백(S15P11E101-869). hint 가 없을 때만 쓴다 — hint 는 로봇이
// 준 문장을 그대로 쓰는 게 원칙이고, 이 표는 그게 없을 때의 안전망이다.
const BLOCKED_HINT: Record<string, string> = {
  MAP_SAVING: '지도 저장 중입니다',
  MAPPING_ACTIVE: '매핑 중입니다',
  NO_MAP: '먼저 매핑하세요',
  LOCALIZATION_NOT_READY: '위치 확인 중입니다',
  NAV_NOT_READY: '주행 시스템 준비 중입니다',
  NO_ROUTE: '지점을 찍으세요',
  ESTOP: '비상정지 해제가 필요합니다',
}

export default function RoutePanel({ inspection = null }: { inspection?: any } = {}) {
  const { enabled, connected, mapping, telemetry } = useLive()
  const { accessToken } = useAuth()

  const [route, setRoute] = useState<import('../../live/contracts.d.ts').Waypoint[]>([])
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
      setRoute(rows); setMsg(null)
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `순찰 경로를 불러오지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  // 지도 클릭 — 서버에 바로 1건 추가한다(POST). 목록만 늘려 두면 새로고침에 사라진다.
  // reason='masked' 는 순찰 마스크로 막힌 칸(S15P11E101-869) — 로봇이 회전 여유까지 계산해
  // 판정한 결과라 맵 바깥 안내와는 다른 문구로 알린다.
  const onPick = async (p: any, reason?: 'outside' | 'masked') => {
    if (!p) {
      setMsg(reason === 'masked'
        ? { kind: 'warn', text: '이 자리는 회전 여유가 없어 순찰 지점으로 찍을 수 없습니다.' }
        : { kind: 'warn', text: '맵 바깥은 지정할 수 없습니다. 회색으로 칠해진 영역 안을 클릭하세요.' })
      return
    }
    if (busy) return
    setBusy(true)
    try {
      const created = await addWaypoint({ ...p, seq: route.length + 1 }, accessToken)
      if (!alive.current) return
      const next = [...route, created]
      setRoute(next)
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
      setRoute(next)
      setMsg({ kind: 'ok', text: `${wpLabel(w, i)} 삭제` })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `삭제하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  // 다른 접속자가 경로를 바꾸면 서버가 /topic/sync 로 알린다 — 새로고침 없이 따라간다.
  // 이 화면은 더 이상 로컬 전용 편집 상태(이름/방향/순서)를 갖지 않으므로 — 추가·삭제가
  // 이미 서버에 바로 반영되므로 — 받은 목록을 그대로 반영하면 된다.
  const refresh = useCallback(async () => {
    if (!enabled || !accessToken) return
    try {
      const rows = await listWaypoints(accessToken)
      if (!alive.current) return
      setRoute(rows)
    } catch {
      // 사용자가 시작한 동작이 아니다 — 다음 알림이 길이다
    }
  }, [enabled, accessToken])
  useResourceSync('patrol-route', refresh)

  // 순찰 시작 — 반드시 /start 로 한다(S15P11E101-625).
  // 로봇이 경로에 저장맵 세션 ID 를 stamp 하므로, 활성 맵이 바뀐 뒤 예전 경로로 autonomy 를
  // 요청하면 거절된다. 경로 재하달과 시작이 한 요청 안에서 붙어 나가야 세션이 맞는다.
  const onStart = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await startPatrol(accessToken, ROBOT_ID)
      if (!alive.current) return
      const m = startPatrolMessage(r)
      setMsg(m)
      // "순찰을 시작합니다"(02) — 시작에 성공했을 때만 안내한다(S15P11E101-891)
      if ((m as any)?.kind !== 'err') playVoice('patrolStart')
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

  // 순찰 시작 가능 여부(S15P11E101-869). 로봇이 readiness 를 보내면 그 판단을 그대로 따르고,
  // FE 는 조건을 조합하지 않는다. 아직 안 보내는 로봇(구버전)에서는 기존 조합 로직 그대로 —
  // 없는데 잠그면 로봇 쪽이 안 올라간 시연 중에 화면이 죽는다.
  const readiness = telemetry?.readiness
  // 🔴 `offline` 만은 readiness 가 있어도 FE 가 판단한다. 나머지 상태 조합은 로봇에 맡긴다.
  //
  // readiness 는 **로봇이 보낸 마지막 값**이다. 연결이 끊기면 그 값이 그대로 남는다 —
  // `canStartPatrol:true` 인 채로 로봇이 사라지면 버튼이 계속 눌리는 상태가 된다.
  // 로봇은 자기가 끊긴 것을 알릴 수 없으므로(끊겼으니까) 이 한 가지는 FE 만 알 수 있다.
  const startDisabled = offline || busy
    || (readiness ? !readiness.canStartPatrol : (mapping || !route.length))
  const startHint = offline
    ? '로봇과 연결이 끊겼습니다.'
    : (readiness && !readiness.canStartPatrol
      ? (readiness.hint || BLOCKED_HINT[readiness.blockedBy ?? ''] || '지금은 순찰을 시작할 수 없습니다.')
      : null)

  return (
    <div className="card-v3" id="pgRoute">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>순찰 경로 <span className="k">PATROL ROUTE</span></h3>
      {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없어 지점을 찍을 수 없습니다. 실서버 모드로 로그인하세요.</p>}
      {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}
      {enabled && (
        <p className="cfg-help">
          지도를 클릭하면 그 자리에 순찰 지점이 추가됩니다. 지점을 찍은 순서대로 로봇이 돕니다.
          <b>순찰 시작</b>을 누르면 저장된 경로로 로봇이 순찰을 시작합니다.
        </p>
      )}

      <div className="vwrap routemap">
        {/* 매핑 중에는 옛 지점 오버레이를 걷고 원본 격자만 보여 준다 */}
        <LiveNavMap
          route={mapping ? null : route}
          onPick={editLocked ? null : onPick}
          mapping={mapping}
          inspection={mapping ? null : inspection}
          follow={mapping}
          lightFloor
          compass={false}
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
            <button type="button" className="btn-tonal" onClick={() => onDelete(w, i)} disabled={editLocked || busy} aria-label={`${i + 1}번 지점 삭제`} style={{ color: '#B4655C', marginLeft: 'auto' }}>삭제</button>
          </li>
        ))}
      </ul>

      <div className="gotor">
        {/* 시작은 눈에 띄게 둔다 — 로봇이 실제로 움직이기 시작하는 버튼이다. filled 는 화면당 하나(S15P11E101-814) */}
        <button
          type="button" id="btnStartPatrol" className="btn-filled" onClick={onStart}
          disabled={startDisabled} title={startHint ?? undefined}
        >
          순찰 시작
        </button>
        {/* 순찰 종료(S15P11E101-868) — 로봇 연동은 아직 없다. 눌러도 아무 일도 일어나지
            않는데, 눌리기만 하면 조작자를 속이는 셈이라 disabled + 안내문으로 명확히 알린다. */}
        <button
          type="button" id="btnStopPatrol" className="btn-outlined"
          disabled
          title="로봇 연동 대기 — 아직 순찰 종료 명령을 보내지 않습니다"
        >
          순찰 종료
        </button>
      </div>
      {startHint && (
        <p className="cfg-help" id="patrolReadinessHint" style={{ marginTop: 6, marginBottom: 0 }}>
          {startHint}
        </p>
      )}
      <p className="cfg-help" style={{ marginTop: 6, marginBottom: 0 }}>
        <b>순찰 종료</b>는 로봇 연동 대기 중입니다 — 지금은 눌러도 아무 동작도 하지 않습니다.
      </p>
    </div>
  )
}
