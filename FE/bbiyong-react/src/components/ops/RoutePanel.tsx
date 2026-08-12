import { errMessage } from '../../live/errors.ts'
import { ROBOT_ID } from '../../live/config.ts'
import { playVoice } from '../../live/voice.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import LiveNavMap from '../robot/LiveNavMap.tsx'
import {
  addWaypoint, deleteWaypoint, listWaypoints, replaceWaypoints, startPatrol, startPatrolMessage, wpLabel,
} from '../../live/waypoints.ts'
import { yawToDegrees } from '../../live/navMap.ts'
import { useResourceSync } from '../../live/sync.ts'

// 순찰 경로 (S15P11E101-514) — 2D 지도를 클릭해 순찰 지점을 찍고, 로봇에 하달한다.
//
// 운영 탭에 둔다. 맵을 만들고(모델링) 그 위에 경로를 그리고 로봇에 내려보내는 흐름이
// 한 화면에서 이어진다. 관제 화면은 모니터링과 실시간 개입만 맡는다(S15P11E101-475).
//
// 지점 이름·방향(heading)·순서 편집 UI 는 뗐다(S15P11E101-814) — 각 지점은 번호와 삭제만
// 남는다. 이름은 여전히 서버 계약(WaypointRequest.name)에 있지만, 이 화면은 값을
// 보내지 않는다(undefined) — addWaypoint 가 이미 '있을 때만' 보내도록 돼 있어
// (조건부 스프레드) 그대로 두면 서버가 기본값(이름 없음 → wpLabel 이 '지점 N'으로 표시)으로
// 채운다. 순서(seq)는 지점을 찍은 순서 그대로 간다 —
// 재정렬 UI(↑/↓)도 뗐으므로 addWaypoint 가 매번 '끝에 추가'로 보내는 seq 가 곧 최종 순서다.
//
// 방향(heading)만은 되살렸다 — -814 는 디자인 v3 재적용이었고 방향 설정 수단이 함께 딸려
// 나갔다(도(degree) 입력칸 + 지도 드래그, S15P11E101-790 · -798). 지도 위 손잡이만 되살린다:
// 각도를 외워 타이핑하는 입력칸은 v3 의 얇은 지점 행과 맞지 않고, 지도에서 바로 가리키는 쪽이
// 애초에 -798 이 입력칸 위에 얹었던 이유다. 방향은 **여전히 선택**이다 — 안 정하면 yaw 를
// 아예 보내지 않고(조건부 스프레드) 로봇이 가까운 구조물을 스스로 바라본다.
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
  NAV_FAILED: '직전 주행이 실패로 끝났습니다',
}

// 🔴 '순찰 시작' 을 누르는 것 자체가 해소하는 차단 사유(S15P11E101-893).
//
// 로봇은 자기가 들고 있는 경로 파일에 저장맵 세션 ID 를 stamp 해 두고, 활성 맵이 바뀌면
// `ROUTE_SESSION_MISMATCH` 로 순찰을 거절한다(navigation_orchestrator._navigation_ready →
// 'patrol route must be reapplied'). 그 stamp 는 SET_PATROL_ROUTE 를 다시 받을 때만 갱신되는데
// (_save_route), 그걸 보내는 API 가 바로 /api/patrol-route/start 다 — apply(SET_PATROL_ROUTE) 후
// SET_MODE autonomy 를 한 요청 안에서 붙여 보낸다(WaypointService.startPatrol).
//
// 즉 이 사유는 **버튼을 눌러야 사라진다.** 그런데 FE 가 이 사유로 버튼을 잠그면 해소 수단이
// 사라진다 — '경로 적용' 버튼을 뗀 뒤(S15P11E101-814) 사용자에게 남은 길이 이 버튼뿐이라
// 매핑 직후 순찰이 영구 잠긴다. 핀을 지웠다 다시 찍어도 안 풀리는 이유도 같다: 핀 추가는
// 서버 DB 에만 쓰고 로봇의 경로 파일은 건드리지 않으므로 stamp 가 그대로다.
//
// 🔴 [2026-08-12] `NO_ROUTE` 도 같은 부류다 — 로봇이 경로를 **아예 안 들고 있는** 경우다.
// 위 stamp 와 똑같은 이유로 교착한다: 핀 추가(`POST /api/patrol-route/points`)는 서버 DB 에만
// 쓰고 로봇에는 내려보내지 않는다. 로봇에 경로가 닿는 길은 /apply 와 /start 뿐인데 '경로 적용'
// 버튼을 뗀 뒤 UI 에서 /apply 를 부르는 곳이 없다 — 그래서 이 사유로 잠그면 **지점을 몇 개
// 찍어도 영구 교착**이다. 2026-08-12 시연에서 실제로 막혔다: 로봇은 scouting READY 인데
// `blockedBy=NO_ROUTE` 하나로 버튼만 잠겨, 핀을 다시 찍어도 화면은 계속 '지점을 먼저 찍으세요'
// 였다(로봇이 옳다 — 로봇에는 정말 경로가 없었다). /start 가 SET_PATROL_ROUTE 를 먼저 보내므로
// 이 사유도 누르는 순간 스스로 풀린다.
//
// 🔴 단, '화면에도 지점이 없는' 진짜 NO_ROUTE 는 여전히 막아야 한다. 그건 아래
// `staleRoute && !route.length` 가 그대로 처리한다 — 이 Set 에 넣어도 그 보호는 안 사라진다.
//
// 나머지 사유(매핑 중·지도 저장 중·위치 미확인 등)는 시작을 눌러도 해소되지 않으므로 그대로 막는다.
const SELF_CLEARING_BLOCKS = new Set(['ROUTE_SESSION_MISMATCH', 'NO_ROUTE'])

// 확대/축소 — 지도 탭 MapPanel 과 같은 값·문법(S15P11E101-911).
const ZOOM_MIN = 0.7
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.2
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))))

// title/mappingControl 은 매핑 탭 통합용(S15P11E101-904) — 매핑 컨트롤 박스를 이 패널
// 상단에 얹고, 카드가 화면을 다 채우며 맵을 크게 보여 준다. 안 주면 기존 '순찰 경로' 그대로.
export default function RoutePanel({ inspection = null, title, mappingControl }: {
  inspection?: any,
  title?: string,
  mappingControl?: import('react').ReactNode,
} = {}) {
  const { enabled, connected, mapping, telemetry, control, robotOnline } = useLive()
  const { accessToken } = useAuth()

  const [route, setRoute] = useState<import('../../live/contracts.d.ts').Waypoint[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)        // { kind: ok|warn|err, text }

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // 전체화면(S15P11E101-907) — 매핑 탭(title 지정 시)에서만 쓴다. 지도 탭 MapPanel 과 같은
  // 방식: 문서 전체화면 + view-fullscreen 클래스 동기화(요청 거부·외부 해제에도 상태 정합).
  const [fullscreen, setFullscreen] = useState(false)
  // 확대/축소(S15P11E101-911) — 매핑 탭에서도 지도 탭처럼 지도를 키워 볼 수 있어야 한다.
  const [zoom, setZoom] = useState(1)
  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => clampZoom(current + delta))
  }, [])
  useEffect(() => {
    const sync = () => {
      const active = document.fullscreenElement === document.documentElement
      setFullscreen(active)
      document.documentElement.classList.toggle('view-fullscreen', active)
    }
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      document.documentElement.classList.remove('view-fullscreen')
    }
  }, [])
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === document.documentElement) await document.exitFullscreen()
      else if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    } catch { /* 브라우저가 막으면 현재 화면 유지 */ }
  }, [])

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
  const onPick = async (p: any, reason?: 'outside' | 'occupied' | 'masked') => {
    if (!p) {
      setMsg(reason === 'masked'
        ? { kind: 'warn', text: '이 자리는 회전 여유가 없어 순찰 지점으로 찍을 수 없습니다.' }
        : reason === 'occupied'
        ? { kind: 'warn', text: '벽 안쪽/미탐색 영역에는 지정할 수 없습니다. 매핑된 흰색 통로 안을 클릭하세요.' }
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

  const offline = !enabled || !connected

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

  // 순찰 종료(S15P11E101-895) — 이 버튼은 '잠깐 멈춤'이 아니라 **제동**이다.
  //
  // `SET_MODE mode=disabled` 는 로봇에서 navigation_orchestrator.set_mode('disabled') 로 가고,
  // 그건 ① _disarm_manual() ② _set_control('disabled') ③ _terminate_locked() 를 한다.
  // ②는 정본 정지 명령인 `control_command stop` 을 실행하며, 제어 파일의 **estop 이 True 가
  // 되어야만** 성공으로 친다(_set_control_once: `expected_estop = mode == 'disabled'`).
  // ③은 순찰 프로세스 자체를 죽인다. 즉 바퀴 출력까지 잠기는 정지다 —
  // FE 비상정지 버튼이 부르는 control.estop() 과 **완전히 같은 명령**이다(LiveContext:
  // `estop: () => send('/app/control/mode', { command:'SET_MODE', mode:'disabled' })`,
  // S15P11E101-732). 그래서 안내 문구를 '멈춤'이 아니라 제동으로 적는다.
  //
  // 되돌릴 수 있다 — '순찰 시작'이 _set_control('autonomy')(=`arm`)로 estop 을 스스로 푼다.
  // (로봇 readiness 주석: "estop 은 차단 사유가 아니다 — 순찰 시작이 스스로 제어를 잡는다")
  // 그래서 확인 대화상자는 넣지 않았다. 시연 중 멈춰야 하는 순간에 한 번 더 묻는 것이 더 위험하고,
  // 되돌리는 비용이 '순찰 시작' 한 번이라 되돌릴 수 없는 조작이 아니다.
  //
  // STOMP publish 는 응답이 없다 — 그래서 "멈췄습니다"가 아니라 "보냈습니다"라고 쓴다.
  // 실제 정지는 텔레메트리 status 가 AUTO_PATROL 에서 빠지는 것으로 확인한다.
  const onStop = () => {
    if (offline) return
    control.setMode('disabled')
    // 서버에는 붙었는데 로봇 세션이 없으면 BE 가 로그만 남기고 버린다(RobotControlStompController).
    // FE 로는 아무 응답도 오지 않으므로 보낸 쪽에서 말해 주지 않으면 멈춘 줄 안다.
    setMsg(robotOnline === false
      ? { kind: 'warn', text: '로봇이 오프라인이라 정지 명령이 전달되지 않았습니다 — 로봇 상태를 확인하세요.' }
      : { kind: 'ok', text: '순찰 종료를 보냈습니다 — 로봇이 멈추고 바퀴 출력이 잠깁니다. 다시 순찰 시작을 누르면 풀립니다.' })
  }

  // 매핑 중에는 경로를 건드리지 못하게 잠근다(S15P11E101-763).
  // 지금 그리는 지도는 옛 지도와 좌표가 다르다 — 그 위에 옛 지점을 얹으면 엉뚱한 자리를
  // 가리키고, 그대로 순찰을 시작하면 로봇이 없는 길로 간다.
  // 서버에 저장된 경로는 지우지 않는다. 매핑이 끝나고 다시 판단할 자산이다.
  const editLocked = offline || mapping

  // 지점 방향(heading) 저장 — 지도에서 지점을 눌러 바깥으로 끌면(LiveNavMap.onSetHeading)
  // 그 지점에서 로봇이 바라볼 방향이 정해진다. yaw=null 이면 '자동'으로 되돌린다.
  //
  // yaw 는 계약 그대로 **radians · map 프레임 · 반시계 + · 0 = map +X** 다 — LiveNavMap 이
  // 이미 그 규약으로 넘겨주므로 여기서는 손대지 않는다. 도(degree)는 화면 표시에만 쓴다.
  //
  // 이 화면은 로컬 편집 버퍼를 두지 않는다(S15P11E101-814) — 추가·삭제처럼 방향도 바로
  // 서버에 쓴다. 한 건만 고치는 API 가 없어 목록 전체 교체(PUT /api/patrol-route)로 보낸다.
  // replaceWaypoints 가 yaw 를 '있을 때만' 실으므로, null 로 두면 키 자체가 빠져
  // 서버·로봇이 예전처럼 '방향 미지정'으로 받는다.
  const saveHeading = async (i: number, yaw: number | null) => {
    if (editLocked || busy) return
    const prev = route
    const next = route.map((w, k) => (k === i ? { ...w, yaw } : w))
    setRoute(next)
    setBusy(true)
    try {
      const rows = await replaceWaypoints(next, accessToken)
      if (!alive.current) return
      if (rows.length) setRoute(rows)
      setMsg(yaw == null
        ? { kind: 'ok', text: `지점 ${i + 1} 방향 자동 — 로봇이 스스로 바라봅니다.` }
        : { kind: 'ok', text: `지점 ${i + 1} 방향 ${yawToDegrees(yaw)}°` })
    } catch (e) {
      if (!alive.current) return
      // 서버에 못 썼으면 화면도 되돌린다 — 저장된 줄 알고 순찰을 시작하는 것이 제일 나쁘다.
      setRoute(prev)
      setMsg({ kind: 'err', text: `방향을 저장하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setBusy(false) }
  }

  // 순찰 시작 가능 여부(S15P11E101-869). 로봇이 readiness 를 보내면 그 판단을 그대로 따르고,
  // FE 는 조건을 조합하지 않는다. 아직 안 보내는 로봇(구버전)에서는 기존 조합 로직 그대로 —
  // 없는데 잠그면 로봇 쪽이 안 올라간 시연 중에 화면이 죽는다.
  const readiness = telemetry?.readiness
  // 🔴 `offline` 만은 readiness 가 있어도 FE 가 판단한다. 나머지 상태 조합은 로봇에 맡긴다.
  //
  // readiness 는 **로봇이 보낸 마지막 값**이다. 연결이 끊기면 그 값이 그대로 남는다 —
  // `canStartPatrol:true` 인 채로 로봇이 사라지면 버튼이 계속 눌리는 상태가 된다.
  // 로봇은 자기가 끊긴 것을 알릴 수 없으므로(끊겼으니까) 이 한 가지는 FE 만 알 수 있다.
  //
  // 단, 로봇이 준 사유가 '시작을 눌러야 풀리는' 것이면(SELF_CLEARING_BLOCKS 주석 참고) 잠그지
  // 않는다. 잠그면 해소 수단이 없어져 교착이다(S15P11E101-893). 대신 무엇이 일어날지 알린다.
  const blockedBy = readiness?.blockedBy ?? ''
  const staleRoute = SELF_CLEARING_BLOCKS.has(blockedBy)
  // 화면에 지점이 하나도 없으면 보낼 경로가 없다 — 로봇이 옛 경로를 들고 있으면 NO_ROUTE 로
  // 오지도 않고, 로봇이 NO_ROUTE 를 보내와도 위에서 self-clearing 으로 풀어 뒀으므로,
  // 두 경우 다 이때는 FE 가 대신 막고 '지점을 찍으라'고 말한다.
  const hardBlocked = !!readiness && !readiness.canStartPatrol && !staleRoute
  const startDisabled = offline || busy
    || (readiness ? (hardBlocked || (staleRoute && !route.length)) : (mapping || !route.length))
  // 🔴 self-clearing 두 사유는 '다음에 할 일'이 서로 다르다 — 뭉뚱그리면 지도를 바꾼 적도
  //    없는데 '지도가 바뀌었습니다'가 뜬다. NO_ROUTE 는 지도가 아니라 하달이 안 된 것이다.
  const startHint = offline
    ? '로봇과 연결이 끊겼습니다.'
    : (staleRoute
      ? (blockedBy === 'NO_ROUTE'
        ? (route.length
          ? '로봇에 경로가 없습니다 — 순찰 시작을 누르면 지금 찍은 지점을 로봇에 보내고 출발합니다.'
          : (readiness?.hint || BLOCKED_HINT.NO_ROUTE))
        : (route.length
          ? '지도가 바뀌었습니다 — 순찰 시작을 누르면 지금 찍은 지점으로 다시 적용하고 출발합니다.'
          : '지도가 바뀌었습니다 — 지도를 클릭해 순찰 지점을 다시 찍으세요.'))
      : (hardBlocked
        ? (readiness.hint || BLOCKED_HINT[blockedBy] || '지금은 순찰을 시작할 수 없습니다.')
        : null))

  // 순찰 중인가 — 로봇 브리지가 patrol 프로세스 실행 여부로 낸 값이다
  // (cloud_bridge.infer_status: patrol_running 이면 AUTO_PATROL). 버튼을 **잠그는 데는 쓰지
  // 않고**(위 주석 참고) 무슨 일이 일어날지 알리는 데만 쓴다.
  const patrolling = telemetry?.status === 'AUTO_PATROL'
  const stopHint = offline
    ? '로봇과 연결이 끊겼습니다.'
    : (patrolling
      ? '순찰을 멈추고 바퀴 출력을 잠급니다. 다시 순찰 시작을 누르면 풀립니다.'
      : '지금은 순찰 중으로 보이지 않습니다 — 눌러도 안전합니다. 정지 상태를 다시 확정합니다.')

  return (
    <div className="card-v3 routepanel" id="pgRoute">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>{title || '순찰 경로'} <span className="k">{title ? 'LIVE MAPPING · PATROL' : 'PATROL ROUTE'}</span></h3>
      {/* 매핑 컨트롤(맵 모델링 시작/중단 + 진행 상태) — 매핑 탭에서 주입한다(S15P11E101-904). */}
      {mappingControl}
      {!enabled && <p className="cfg-help">시뮬레이션 모드에서는 실제 맵이 없어 지점을 찍을 수 없습니다. 실서버 모드로 로그인하세요.</p>}
      {enabled && !connected && <p className="cfg-help">실서버 연결 대기 중입니다.</p>}
      {enabled && (
        <p className="cfg-help">
          지도를 클릭하면 그 자리에 순찰 지점이 추가됩니다. 지점을 찍은 순서대로 로봇이 돕니다.
          <b>지점을 누른 채 바라볼 방향으로 끌면</b> 그 지점의 방향이 정해집니다(분전반 쪽을
          보게 하고 싶을 때). 방향을 안 정하면 로봇이 가까운 구조물을 스스로 바라봅니다.
          <b>순찰 시작</b>을 누르면 저장된 경로로 로봇이 순찰을 시작합니다.
        </p>
      )}

      <div className="vwrap routemap">
        {/* 매핑 중에는 옛 지점 오버레이를 걷고 원본 격자만 보여 준다 */}
        <LiveNavMap
          route={mapping ? null : route}
          onPick={editLocked ? null : onPick}
          onSetHeading={editLocked ? null : saveHeading}
          zoomFactor={zoom}
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
        {/* 전체화면 — 지도 탭과 같은 방식(문서 전체화면 + view-fullscreen 클래스). S15P11E101-907 */}
        {title && (
          <div className="map-controls routemap-controls" aria-label="지도 화면 조절">
            <button
              type="button" className="map-control zoom-in"
              onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}
              aria-label="지도 확대" title="지도 확대"
            >+</button>
            <button
              type="button" className="map-control zoom-out"
              onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}
              aria-label="지도 축소" title="지도 축소"
            >−</button>
            <button
              type="button" className="map-control fullscreen"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? '전체화면 종료' : '지도 전체화면'}
              aria-pressed={fullscreen}
              title={fullscreen ? '전체화면 종료 (Esc)' : '지도 전체화면'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {fullscreen
                  ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                  : <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />}
              </svg>
            </button>
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
            {/* 지도 위 뱃지와 같은 각도를 목록에서도 읽는다. 방향은 선택이라 '자동'이 정상 상태다. */}
            <span className="t" style={{ marginLeft: 4 }}>
              {w.yaw != null && Number.isFinite(Number(w.yaw)) ? `방향 ${yawToDegrees(Number(w.yaw))}°` : '방향 자동'}
            </span>
            {w.yaw != null && Number.isFinite(Number(w.yaw)) && (
              <button
                type="button" className="btn-tonal" onClick={() => saveHeading(i, null)}
                disabled={editLocked || busy} aria-label={`${i + 1}번 지점 방향 자동으로`}
                title="방향을 지정하지 않은 상태로 되돌립니다 — 로봇이 가까운 구조물을 스스로 바라봅니다."
                style={{ padding: '4px 10px' }}
              >
                방향 자동
              </button>
            )}
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
        {/* 순찰 종료(S15P11E101-895) — -868 의 '로봇 연동 대기' 는 낡은 설명이었다.
            FE control.setMode · BE /app/control/mode · 로봇 set_mode('disabled') 3단이 이미 다 있다.

            🔴 비활성 조건을 `offline` 하나로 둔다. '순찰 중일 때만 활성' 으로 좁히지 않는다 —
            순찰 여부는 텔레메트리에서 **추정한** 값이고(cloud_bridge.infer_status → patrol_running),
            그 값이 늦거나 끊기면 **움직이는 로봇을 멈출 수 없게 된다.** 정지 수단을 추정 상태로
            잠그는 것이 바로 -893 이 났던 방식이다. 정지는 언제 눌러도 안전하다(이미 멈춰 있으면
            멈춘 상태를 다시 확정할 뿐이다). */}
        <button
          type="button" id="btnStopPatrol" className="btn-outlined"
          onClick={onStop} disabled={offline} title={stopHint}
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
        <b>순찰 종료</b>는 로봇을 즉시 멈추고 바퀴 출력을 잠급니다 — 비상정지와 같은 제동입니다.
        다시 <b>순찰 시작</b>을 누르면 잠금이 풀리고 순찰이 이어집니다.
      </p>
    </div>
  )
}
