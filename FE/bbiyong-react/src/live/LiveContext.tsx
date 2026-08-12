import { errMessage } from './errors.ts'
// 실서버(STOMP) 연동 컨텍스트 — docs/fe_backend_integration_guide.md §3·§4 구현.
//
// 로컬 시뮬레이션(SimContext)은 그대로 두고 그 위에 얹는다. 컴포넌트는 live 모드일 때만
// 이쪽 값을 쓰고, mock 모드에서는 기존 시뮬 동작이 100% 유지된다.
//
// 가이드가 정의하는 실서버 구간은 순찰 로봇(텔레메트리·경보·영상·제어)뿐이다.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ROBOT_ID, getDataSource, saveDataSource } from './config.ts'
import { connect, disconnect, subscribe, publish, onState, setToken } from './stompClient.ts'
import { DEFAULT_DRIVE_SPEED, angularFor, clampDriveSpeed } from './mappers.ts'
import { useSettings } from '../settings/SettingsContext.tsx'
import { decodeMapSnapshot, bakeMap, patrolMaskBlock, decodePatrolMask, bakeMask, TRAIL_MAX } from './navMap.ts'
import { activateMap, isMappingComplete, isMappingStatus, phaseOf, fetchMapStatus, PHASE_IDLE, PHASE_MAPPING } from './mapping.ts'
import { TILT_COMMAND } from './cameraTilt.ts'
import { isFloorplanReady, loadActivePlan, releasePlan } from './floorplan.ts'
import { authedGet, refreshAccessToken } from './authApi.ts'
import {
  DENY, EMPTY_OWNERSHIP, OWNERSHIP_DEST, OWNERSHIP_KEEPALIVE_MS, OWNERSHIP_QUEUE,
  isMine, isOwnedByOther, isStale, leftMsNow, ownershipTopic, parseControlPayload,
} from './controlOwnership.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import { REASON, STOMP_AUTH_GRACE_MS } from '../auth/sessionPolicy.ts'

/**
 * 컨텍스트가 실제로 공급하는 값. Provider 안에서 만드는 value 객체에서 그대로 끌어온다 —
 * 형태를 손으로 다시 적으면 Provider 가 바뀔 때 어긋난다.
 */
const LiveContext = createContext<import('./contracts.d.ts').LiveContextValue | null>(null)

/**
 * Provider 밖에서 부르면 던지므로 반환 타입을 non-null 로 좁힌다
 * (useAuth·useSettings·useSim 과 같은 규칙 — S15P11E101-570).
 */
export function useLive(): import('./contracts.d.ts').LiveContextValue {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used within <LiveProvider>')
  return ctx
}

// 텔레메트리는 연속 변동값 → 기존 시뮬(400ms emit)과 같은 취지로 주기 플러시해 리렌더를 억제한다.
const TELEMETRY_FLUSH_MS = 250

// 로봇 가동 여부 조회 주기. 서버의 OFFLINE 판정 자체가 무수신 임계 시간 기반이라
// 더 자주 물어도 얻을 것이 없다.
const ROBOT_POLL_MS = 15000

let alertUid = 0

export function LiveProvider({ children }: any) {
  const { accessToken, logout, user, canOperate } = useAuth()
  // 주행 상한은 설정 탭에서 바뀔 수 있다 — ref 로 들고 control 의 정체성은 고정한다
  const { settings } = useSettings()
  const vMaxRef = useRef(settings.vMax)
  vMaxRef.current = settings.vMax
  // 각속도 상한도 서버 설정을 따른다(S15P11E101-515)
  const wMaxRef = useRef(settings.wMax)
  wMaxRef.current = settings.wMax
  const [dataSource, setDataSourceState] = useState(getDataSource)
  const enabled = dataSource === 'live'

  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [authError, setAuthError] = useState(false)
  const [telemetry, setTelemetry] = useState<import('./contracts.d.ts').RobotTelemetry | null>(null)
  const [alerts, setAlerts] = useState<import('./contracts.d.ts').LiveAlertMessage[]>([])
  // 맵 모델링 완료 이벤트(S15P11E101-483). 마지막 1건만 들고 있으면 충분하다 —
  // 운영 탭이 '이 맵 사용?' 안내를 띄우고 사용자가 확인하면 지운다.
  const [mappingComplete, setMappingComplete] = useState<any>(null)
  // 매핑 진행 단계(S15P11E101-744). null = 아직 모른다.
  // '모른다' 를 IDLE 과 구분해 둔다 — 모르는 상태에서 도면을 띄우면, 실제로는
  // 매핑 중인데 지도 탭이 옛 도면을 보여 주는 일이 생긴다.
  const [mappingPhase, setMappingPhase] = useState<import('./contracts.d.ts').MappingPhase | null>(null)
  // 매핑 시작 대기(S15P11E101). START_MAPPING 을 보낸 순간부터 로봇이 실제로 매핑에
  // 들어가(MAPPING_STATUS) mapping 이 true 가 되기까지의 공백을 메운다 — 그 사이 지도 탭이
  // 아무 표시 없이 옛 도면을 보여 주지 않도록, 이 신호가 켜지면 로딩 화면을 띄운다.
  const [mappingStarting, setMappingStarting] = useState(false)
  // 정제 도면(S15P11E101-524). planReady 는 알림, plan 은 실제로 받아 온 도면이다.
  const [planReady, setPlanReady] = useState<any>(null)
  const [plan, setPlan] = useState<import('./contracts.d.ts').PlanLayer | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  // 로봇 가동 여부(S15P11E101-510). STOMP 연결은 '관제↔서버'만 말해준다 —
  // 로봇이 꺼져 있어도 connected 는 true 라서, 서버가 판정한 online 을 따로 받아야 한다.
  // null = 아직 모름(조회 전·실패). 모름을 offline 으로 위장하지 않는다.
  const [robotOnline, setRobotOnline] = useState<boolean | null>(null)

  // 사용자가 고른 제어 모드(S15P11E101-448 · 513). 조작 패널의 지역 상태였는데,
  // 키보드 주행을 발행하는 LiveSimBridge 도 이 값을 봐야 해서 연동 레이어로 올린다 —
  // 순찰 모드에서는 WASD 가 DRIVE 를 보내면 안 된다.
  const [driveMode, setDriveMode] = useState<'patrol' | 'manual'>('patrol')

  // ---- 조종 점유(S15P11E101-778 · 779 / BE MR !344) ----
  // 서버가 로봇 1대의 조종권을 리스로 관리한다. 여기서는 그 상태를 그대로 들고 있다가
  // 화면이 "누가 조종 중인지"를 보여주고 수동 모드 진입을 막을 수 있게 한다.
  const [ownership, setOwnership] = useState(EMPTY_OWNERSHIP)
  const ownershipRef = useRef(EMPTY_OWNERSHIP)
  const applyOwnership = useCallback((next: typeof EMPTY_OWNERSHIP) => {
    ownershipRef.current = next
    setOwnership(next)
  }, [])
  // 내 STOMP sessionId. CONNECTED 프레임의 session 헤더로 받거나(서버가 실어 줄 때),
  // 내 ACQUIRE 가 성공한 순간의 owner 값으로 학습한다.
  const [mySessionId, setMySessionId] = useState<string | null>(null)
  const mySessionIdRef = useRef<string | null>(null)
  mySessionIdRef.current = mySessionId
  const myEmail = user?.email ?? null
  const myEmailRef = useRef<string | null>(myEmail)
  myEmailRef.current = myEmail
  // 카운트다운·무수신 판정을 다시 그리기 위한 틱. 점유가 있을 때만 돈다.
  const [ownershipTick, setOwnershipTick] = useState(0)

  /**
   * /app/control/ownership 발행.
   *
   * ACQUIRE·TAKEOVER 는 claim 을 'pending' 으로 올린다 — 곧이어 도착하는 ACQUIRED
   * 브로드캐스트의 owner 가 곧 내 sessionId 라는 사실을 그때 학습하기 위해서다.
   */
  // 내 획득 요청이 나간 시각. 뒤이어 오는 ACQUIRED/TAKEN_OVER 방송이 '내 것'인지 가르는 근거다.
  const claimSentAt = useRef(0)
  // 내가 낸 탈취 요청 시각. 서버는 탈취 순간 이전 소유자에게 TAKEN_OVER_BY_OTHER 를 보내는데,
  // 그 통지가 계정 단위라 탈취를 건 사람에게도 되돌아온다 — 그것을 내 패배로 읽으면 안 된다.
  const takeoverSentAt = useRef(0)
  // sessionId 를 학습한 시각. 방금 배운 것을 뒤집는 거부가 오면 되돌리는 데 쓴다.
  const learnedAt = useRef(0)
  const sendOwnership = useCallback((command: 'ACQUIRE' | 'TAKEOVER' | 'RELEASE' | 'STATUS') => {
    if (!publish(OWNERSHIP_DEST, { robot_id: ROBOT_ID, command })) return false
    if (command === 'ACQUIRE' || command === 'TAKEOVER') {
      if (command === 'TAKEOVER') takeoverSentAt.current = Date.now()
      const cur = ownershipRef.current
      // 이미 내 것이면 이것은 '갱신'이다. 갱신까지 요청 시각으로 찍으면, 그 직후 남이
      // 가져간 ACQUIRED 방송을 내 성공으로 오독한다 — 실제로 이 실수를 검증에서 봤다.
      if (cur.claim !== 'owner') {
        claimSentAt.current = Date.now()
        applyOwnership({ ...cur, claim: 'pending', denied: null })
      }
    }
    return true
  }, [applyOwnership])

  // 영상 프레임은 초당 수십 장이 들어올 수 있어 React state로 올리지 않는다.
  // ref에 최신 프레임만 두고, 캔버스를 그리는 쪽이 리스너로 직접 받아간다.
  const videoRef = useRef<Record<string, any>>({ FRONT: null, THERMAL: null })
  const videoListeners = useRef(new Set<(ch: 'FRONT' | 'THERMAL', frame: any) => void>())
  // 채널별로 프레임을 한 번이라도 받았는지. capabilities 가 online 이어도 프레임이 안 오면
  // 캔버스에는 시뮬 화면이 그대로 남아 실데이터처럼 보인다(S15P11E101-462).
  const [videoSeen, setVideoSeen] = useState<Record<string, boolean>>({ FRONT: false, THERMAL: false })

  // 🆕 [2026-08-12] 검출 박스(DETECTIONS).
  //
  // 왜 별도 메시지인가: 전면 영상이 HLS 로 옮겨가면서 **프레임에 메타데이터를 실을 수
  // 없게 됐다.** 종전에는 로봇이 박스를 JPEG 픽셀에 그려 보냈지만, MJPEG 패스스루는
  // 카메라 원본을 그대로 흘리므로 그 자리가 없다.
  //
  // 영상 프레임과 같은 이유로 state 가 아니라 ref 에 둔다 — 4Hz 라 state 로 올려도
  // 무리는 아니지만, 구독자가 오버레이 캔버스 하나뿐이라 리렌더를 만들 이유가 없다.
  const detRef = useRef<import('./contracts.d.ts').DetectionsMessage | null>(null)
  const detListeners = useRef(new Set<(det: import('./contracts.d.ts').DetectionsMessage) => void>())

  const telemetryRef = useRef<import('./contracts.d.ts').RobotTelemetry | null>(null)

  // 실시간 SLAM 맵(가이드 §5). NAV_LIVE 가 3Hz 로 오고 scan 배열이 커서 영상 프레임과 같은
  // 방식으로 다룬다 — React state 로 올리지 않고 ref 에 최신값만 두고 리스너가 직접 받아간다.
  /** @type {import('react').MutableRefObject<import('./contracts').NavState>} */
  const navRef = useRef<import('./contracts.d.ts').NavState>({ map: null, mapCanvas: null, pose: null, scan: null, trail: [], plan: null, maskCanvas: null })
  const navListeners = useRef(new Set<(nav: import('./contracts').NavState) => void>())
  // 구독자를 서로 격리한다. 한 리스너가 던지면 forEach 가 거기서 끊겨 뒤쪽 구독자는
  // 갱신을 못 받는다 — 관제 캔버스가 실패했다고 운영 탭 진행 표시까지 멈추면 안 된다.
  const emitNav = useCallback(() => {
    navListeners.current.forEach((fn) => {
      try { fn(navRef.current) } catch (e) { console.warn('[nav] 구독자 오류 — 나머지는 계속', e) }
    })
  }, [])

  // 새 매핑에 들어갈 때 이전 세션의 화면을 지운다(S15P11E101-763).
  //
  // 지우지 않으면 지난번 지도·궤적 위에 새 스캔이 겹쳐 쌓인다. 조작자는 그것을
  // '지금 그리고 있는 구역' 으로 읽고, 실제로는 없는 벽을 있다고 믿게 된다.
  //
  // 저장된 도면(plan)은 건드리지 않는다 — 매핑이 끝나면 다시 써야 하는 자산이다.
  // 지금 배경으로 쓰지 않을 뿐이고, 그 판단은 그리는 쪽에서 한다.
  const resetMappingView = useCallback(() => {
    const n = navRef.current
    n.map = null
    n.mapCanvas = null
    n.pose = null
    n.scan = null
    n.trail = []
    n.maskCanvas = null
    emitNav()
  }, [emitNav])

  const setDataSource = useCallback((value: 'live' | 'mock') => {
    saveDataSource(value)
    setDataSourceState(value)
  }, [])

  const toggleDataSource = useCallback(() => {
    setDataSource(getDataSource() === 'live' ? 'mock' : 'live')
  }, [setDataSource])

  // 토큰은 연결 수명주기보다 먼저 반영한다 — 아래 연결 effect가 이 값으로 CONNECT 한다.
  // 세션 도중 토큰이 바뀌면 setToken() 이 재연결시킨다(구독은 유지).
  useEffect(() => { setToken(accessToken) }, [accessToken])

  // ---- 연결 · 구독 ----
  // 토큰이 없으면 아예 붙지 않는다. 인증 강제(S15P11E101-418) 이후 무토큰 CONNECT는
  // 100% 거부되므로, 시도하면 reconnectDelay 주기로 거부만 반복하며 서버를 두드리게 된다.
  const canConnect = enabled && !!accessToken
  useEffect(() => {
    if (!canConnect) {
      setConnected(false); setLastError(null); setAuthError(false)
      setTelemetry(null); telemetryRef.current = null
      setMappingComplete(null)
      videoRef.current = { FRONT: null, THERMAL: null }
      setVideoSeen({ FRONT: false, THERMAL: false })
      navRef.current = { map: null, mapCanvas: null, pose: null, scan: null, trail: [], plan: null, maskCanvas: null }
      emitNav()
      applyOwnership(EMPTY_OWNERSHIP); setMySessionId(null)
      disconnect()
      return undefined
    }

    const offState = onState(({ connected: c, lastError: e, authError: a, sessionId: sid }: {
      connected: boolean, lastError: string | null, authError: boolean, hasToken: boolean,
      sessionId: string | null,
    }) => {
      setConnected(c); setLastError(e); setAuthError(!!a)
      // 서버가 CONNECTED 에 session 을 실어 주면 그게 정답이다. 안 실어 주면 null 이 오고,
      // 그때는 ACQUIRE 왕복으로 학습한 값을 유지한다(덮어써서 지우면 안 된다).
      if (sid) setMySessionId(sid)
      else if (!c) setMySessionId(null)   // 세션이 끊기면 학습값도 무효
    })

    const robotStateMap = new Map<string, string>()

    const offRobots = subscribe('/topic/robots',
      /** @param {import('./contracts').RobotTelemetry} msg */ (msg: any) => {
        telemetryRef.current = msg
        if (!msg) return
        const rid = msg.robotId || msg.robot_id || ROBOT_ID
        const status = msg.status || msg.state
        const isOffline = status === 'OFFLINE'
        const isStateUpdate = msg.type === 'STATE_UPDATE' || msg.event === 'STATE_UPDATE'
        const prevState = robotStateMap.get(rid)

        let logState: 'ONLINE' | 'OFFLINE' | null = null
        if (isStateUpdate) {
          logState = (msg.event === 'ONLINE' || msg.status === 'ONLINE' || status === 'ONLINE' || (!isOffline && msg.event !== 'OFFLINE')) ? 'ONLINE' : 'OFFLINE'
          // 온·오프 판정은 REST 폴링(아래)이 정답이지만 주기가 있어 몇 초 늦는다.
          // STATE_UPDATE 는 그 사실이 확정된 순간에 오므로 먼저 반영한다 —
          // 로봇이 꺼졌는데 지도 위 마커가 몇 초 더 멀쩡히 떠 있으면 안 된다(S15P11E101-745).
          if (rid === ROBOT_ID) {
            setRobotOnline(typeof msg.online === 'boolean' ? msg.online : logState === 'ONLINE')
          }
        } else if (status) {
          const newState = isOffline ? 'OFFLINE' : 'ONLINE'
          if (prevState && prevState !== newState) {
            logState = newState
          }
          robotStateMap.set(rid, newState)
        }

        if (logState) {
          const timestamp = msg.timestamp || Date.now()
          setAlerts((prev) => [
            ...prev,
            {
              _id: ++alertUid,
              type: 'SYSTEM',
              level: logState === 'ONLINE' ? 'WARNING' : 'CRITICAL',
              robotId: rid,
              timestamp,
              message: `로봇 [${rid}] ${logState === 'ONLINE' ? '연결 (ONLINE)' : '해제 (OFFLINE)'}`,
            }
          ])
        }
      })

    const offAlerts = subscribe('/topic/alerts',
      /** @param {import('./contracts').AlertMessage | import('./contracts').MappingMessage} msg */ (msg: any) => {
      // 맵 모델링 완료는 위험 경보가 아니다 — 화재/과열 토스트로 흘리면
      // alertToToast 가 타입 문자열을 그대로 띄운다. 운영 탭 전용 상태로 뺀다.
      if (isMappingComplete(msg)) { setMappingComplete({ ...msg, _at: Date.now() }); return }
      // 서버 경보는 one-shot — 대응하는 "해제" 이벤트가 없다(가이드 §4).
      setAlerts((prev) => [...prev, { ...msg, _id: ++alertUid }])
    })

    // 매핑 토픽(S15P11E101-482 · 510 · 524). 두 종류가 온다 —
    //   EVENT_MAPPING_COMPLETE : 로봇 원문 relay (매핑이 끝났다)
    //   FLOORPLAN_READY        : 서버가 정제 도면을 만들어 활성화했다
    // 도착 자체를 완료로 보면 도면 알림에도 '이 맵을 사용할까요?' 가 다시 뜬다.
    const offMapping = subscribe('/topic/mapping',
      /** @param {import('./contracts').MappingMessage} msg */ (msg: any) => {
      const m = (typeof msg === 'object' && msg) ? msg : {}
      // 진행 전환은 지도 탭이 무엇을 보여 줄지를 가른다 — 가장 먼저 본다.
      if (isMappingStatus(m)) {
        const next = phaseOf(m)
        if (next) setMappingPhase(next)
        return
      }
      if (isFloorplanReady(m)) {
        // 도면이 나왔다는 것은 매핑이 끝났다는 뜻이다. 서버가 MAPPING_STATUS 를
        // 따로 보내지 않아도 지도 탭이 '매핑중' 에 갇히지 않게 여기서 함께 푼다.
        setMappingPhase(PHASE_IDLE)
        setPlanReady({ ...m, _at: Date.now() })
        const mapId = m.mapId || m.map_id
        if (mapId && accessToken) {
          activateMap(mapId, accessToken).catch(() => {})
        }
        return
      }
      setMappingComplete({ ...m, _at: Date.now() })
    })

    const offVideo = subscribe(`/topic/video/${ROBOT_ID}`, (frame: any) => {
      if (frame instanceof Uint8Array) {
        videoRef.current.FRONT = frame
        setVideoSeen((prev) => (prev.FRONT ? prev : { ...prev, FRONT: true }))
        videoListeners.current.forEach((fn) => fn('FRONT', frame))
        return
      }
      const ch = frame?.channel
      if (ch !== 'FRONT' && ch !== 'THERMAL') return
      videoRef.current[ch] = frame
      setVideoSeen((prev) => (prev[ch] ? prev : { ...prev, [ch]: true }))
      videoListeners.current.forEach((fn) => fn(ch, frame))
    })

    // 🆕 [2026-08-12] 검출 박스. 영상과 같은 토픽으로 오되 type 으로 갈린다.
    //
    // 🔴 box 는 **src_w x src_h 기준 픽셀 절대좌표**다. 받는 쪽이 반드시 src_w/src_h 로
    //    환산해야 한다 — 로봇 추론은 640x360, 영상은 1280x720 이라 고정 상수로 나누면
    //    정확히 2배 어긋난다(실측 확인).
    // 🔴 빈 dets 도 온다. 그래야 "불이 꺼졌다"를 알고 박스를 지운다.
    const offDet = subscribe(`/topic/video/${ROBOT_ID}`, (msg: any) => {
      if (msg instanceof Uint8Array || msg?.type !== 'DETECTIONS') return
      detRef.current = msg
      detListeners.current.forEach((fn) => {
        try { fn(msg) } catch (e) { console.warn('[det] 구독자 오류 — 나머지는 계속', e) }
      })
    })

    // 실시간 SLAM 맵 — 한 토픽에 MAP/NAV_LIVE 두 종류가 오고 type 으로 갈린다(가이드 §1).
    const offNav = subscribe(`/topic/nav/${ROBOT_ID}`,
      /** @param {import('./contracts').MapSnapshot | import('./contracts').NavLive | import('./contracts').MappingMessage} msg */ (msg: any) => {
      const nav = navRef.current
      if (msg?.type === 'MAP') {
        // 순찰 가능 마스크(S15P11E101-869) — 아직 안 보낼 수 있다. 없거나 깨졌으면
        // 오버레이 없이 기존 동작 그대로 둔다(마스크 없다고 클릭이 막히면 안 된다).
        // 필드 이름·격자 정합 판정은 patrolMaskBlock 한 곳에 모여 있다.
        const usableMask = patrolMaskBlock(msg)
        const maskRev = usableMask ? (usableMask.revision ?? null) : null

        // 서버는 snapshot 만 보낸다(patch 없음). sequence 가 바뀔 때만 지도를 다시 굽는다.
        // 다만 마스크는 지도 셀이 그대로여도 바뀌고 그때 sequence 는 오르지 않으므로
        // (계약 §6), revision 이 달라지면 마스크만 다시 굽는다.
        const sameMap = !!(nav.map && nav.map.seq === msg.sequence)
        if (sameMap && nav.map!.maskRev === maskRev) return
        if (!sameMap) {
          try {
            nav.map = decodeMapSnapshot(msg)
            nav.mapCanvas = bakeMap(nav.map)
          } catch (e) {
            // 크기가 안 맞는 맵은 버리고 직전 맵을 유지한다 — 깨진 화면보다 낫다
            console.warn('[nav] 맵 디코드 실패 — 이전 맵 유지', errMessage(e))
            return
          }
        }
        nav.map!.maskRev = maskRev
        try {
          nav.map!.mask = usableMask ? decodePatrolMask(usableMask, nav.map!.w, nav.map!.h) : null
          nav.maskCanvas = nav.map!.mask ? bakeMask(nav.map!.mask, nav.map!.w, nav.map!.h) : null
        } catch (e) {
          console.warn('[nav] 순찰 마스크 디코드 실패 — 마스크 없이 진행', errMessage(e))
          nav.map!.mask = null
          nav.maskCanvas = null
        }
      } else if (isMappingComplete(msg)) {
        // 완료 이벤트가 어느 토픽으로 올지 계약에 없다. 맵과 같은 토픽으로 올 수도 있어 여기서도 받는다.
        setMappingComplete({ ...msg, _at: Date.now() })
        return
      } else if (msg?.type === 'NAV_LIVE') {
        nav.pose = msg.pose || null
        nav.scan = msg.scan || null
        if (msg.pose) {
          nav.trail = [...nav.trail, [msg.pose.x, msg.pose.y]]
          if (nav.trail.length > TRAIL_MAX) nav.trail = nav.trail.slice(-TRAIL_MAX)
        }
      } else return
      emitNav()
    })

    // ---- 조종 점유 상태 방송 (BE MR !344) ----
    // 점유가 있을 때만 서버가 500ms 하트비트를 보낸다. 비어 있으면 아무것도 오지 않으므로
    // "한동안 조용하다" 는 곧 "비었다" 가 아니다 — 아래 STATUS 재조회가 그 공백을 메운다.
    const offOwnership = subscribe(ownershipTopic(ROBOT_ID), (raw: any) => {
      const m = parseControlPayload(raw)
      if (!m) return
      const owner: string | null = m.owner ?? null
      const prev = ownershipRef.current
      const learned = mySessionIdRef.current
      let claim = prev.claim
      let denied = prev.denied

      // 내 요청이 나간 직후 도착한 획득 알림인가. 서버는 거부를 방송하지 않고 개인 큐로만
      // 알리므로, ACQUIRED·TAKEN_OVER 방송이 왔다는 것 자체가 "누군가 성공했다"는 뜻이다.
      const justAsked = claimSentAt.current > 0 && Date.now() - claimSentAt.current < 3000
      const gotIt = !!owner && (m.event === 'ACQUIRED' || m.event === 'TAKEN_OVER') && justAsked
        && (!m.ownerEmail || !myEmailRef.current || m.ownerEmail === myEmailRef.current)

      if (!owner) {
        // 점유가 비었다 — 내 소유도, 거부 상태도 더는 유효하지 않다
        if (claim === 'owner' || claim === 'denied') claim = 'none'
        denied = null
      } else if (gotIt) {
        // 서버가 CONNECTED 에 session 헤더를 주지 않을 때 내 sessionId 를 아는 유일한 경로.
        // 거부 통지(계정 단위)가 먼저 도착해 claim 이 denied 로 내려갔더라도 여기서 되돌린다 —
        // 강제 탈취를 건 사람에게도 이전 소유자용 통지가 함께 오기 때문이다.
        mySessionIdRef.current = owner
        setMySessionId(owner)
        learnedAt.current = Date.now()
        claim = 'owner'; denied = null
        claimSentAt.current = 0
      } else if (learned) {
        if (owner === learned) { claim = 'owner'; denied = null }
        else if (claim !== 'pending') claim = 'none'
      } else if (m.event === 'ACQUIRED' || m.event === 'TAKEN_OVER') {
        // 내 요청이 아닌데 리스가 새로 넘어갔다 = 내가 들고 있었다면 잃은 것이다.
        // sessionId 를 아직 모르는 상태에서도 이 한 줄이 소유권 착각을 막는다.
        if (claim === 'owner') claim = 'none'
      }

      applyOwnership({
        supported: true,
        owner,
        ownerEmail: m.ownerEmail ?? null,
        event: m.event ?? null,
        leftMs: Number(m.leftMs) || 0,
        receivedAt: Date.now(),
        claim,
        denied,
      })
    })

    // ---- 개인 큐: 내 명령이 왜 버려졌는지 ----
    // Spring 의 user destination 은 계정 단위라, 같은 계정으로 연 다른 탭의 거부도 여기로 온다.
    // 내가 소유자로 확인된 상태에서 온 OWNED_BY_OTHER 는 남의 것이므로 무시한다 —
    // 그러지 않으면 조종 중인 탭이 관전 탭 때문에 스스로 조종을 놓는다.
    const offDenied = subscribe(OWNERSHIP_QUEUE, (raw: any) => {
      const m = parseControlPayload(raw)
      if (!m || m.type !== 'CONTROL_DENIED') return
      const prev = ownershipRef.current
      const reason = String(m.reason || '')
      const mySid = mySessionIdRef.current
      // 방금 학습한 sessionId 를 곧바로 부정하는 거부가 왔다 = 잘못 배웠다.
      //
      // 두 사람이 거의 동시에 ACQUIRE 를 보내면, 진 쪽도 3초 안에 이긴 쪽의 ACQUIRED 방송을
      // 받으므로 남의 sessionId 를 자기 것으로 배울 수 있다. 그 직후 도착하는 내 거부가
      // 유일한 정정 신호다 — 여기서 배운 것을 물리지 않으면 진 쪽이 조종자 행세를 한다.
      if (reason === DENY.OWNED_BY_OTHER && mySid && Date.now() - learnedAt.current < 1500) {
        mySessionIdRef.current = null
        setMySessionId(null)
        learnedAt.current = 0
        applyOwnership({
          ...prev, supported: true, claim: 'denied',
          denied: { reason, ownerEmail: m.ownerEmail ?? null, at: Date.now() },
        })
        return
      }
      // 지금 리스가 내 것이라고 서버가 말하고 있으면, 이 거부는 같은 계정의 다른 탭 것이다
      if (mySid && m.owner && m.owner === mySid) return
      // 방금 내가 탈취를 걸었다 — 이전 소유자에게 가는 통지가 나에게도 되돌아온 것뿐이다
      if (reason === DENY.TAKEN_OVER_BY_OTHER && Date.now() - takeoverSentAt.current < 3000) return
      // 내가 소유자로 확인된 상태에서 온 '남이 잡고 있다' 는 내 것이 아니다
      if (reason !== DENY.TAKEN_OVER_BY_OTHER && isMine(prev, mySid)) return
      applyOwnership({
        ...prev,
        supported: true,
        claim: 'denied',
        denied: { reason, ownerEmail: m.ownerEmail ?? null, at: Date.now() },
      })
    })

    const flush = setInterval(() => {
      if (telemetryRef.current) setTelemetry(telemetryRef.current)
    }, TELEMETRY_FLUSH_MS)

    // CONNECT 프레임에 JWT를 실어 연결한다(가이드 §1).
    // 인증 강제(S15P11E101-418)가 배포되어, 토큰이 없거나 무효면 ERROR 프레임으로 거부된다.
    connect()

    return () => {
      clearInterval(flush)
      offRobots(); offAlerts(); offMapping(); offVideo(); offDet(); offNav()
      offOwnership(); offDenied(); offState()
      disconnect()
    }
  }, [canConnect, emitNav, applyOwnership])

  // 로봇 가동 여부는 서버가 판정한다 — 텔레메트리가 끊긴 지 일정 시간이 지나면 OFFLINE
  // (RobotService). 관제는 그 결과를 GET /api/robots 로 받아온다(가이드 · S15P11E101-510).
  // 텔레메트리 스트림만 보면 "한 번도 안 온 것"과 "오다가 끊긴 것"을 구별하지 못한다.
  useEffect(() => {
    if (!canConnect) { setRobotOnline(null); return undefined }
    let alive = true
    const poll = async () => {
      try {
        const rows = await authedGet('/api/robots', accessToken)
        if (!alive) return
        const list = Array.isArray(rows) ? rows : (rows?.content || [])
        const me = list.find((r: any) => r?.robotId === ROBOT_ID)
        // 필드가 없으면 status 로 보조 판정한다 — online 을 안 주는 서버 버전이 있다.
        setRobotOnline(me ? (me.online ?? (me.status !== 'OFFLINE')) : false)
      } catch {
        if (alive) setRobotOnline(null)   // 조회 실패는 '꺼짐'이 아니라 '모름'이다
      }
    }
    poll()
    const id = setInterval(poll, ROBOT_POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [canConnect, accessToken])

  // 매핑 진행 상태를 복원한다(S15P11E101-744). STOMP 는 붙기 전에 지나간 전환을
  // 다시 주지 않으므로, 새로고침하거나 매핑 도중에 접속하면 이 요청이 유일한 근거다.
  useEffect(() => {
    if (!canConnect) { setMappingPhase(null); return undefined }
    let alive = true
    fetchMapStatus(ROBOT_ID, accessToken)
      .then((res) => { if (alive) setMappingPhase(phaseOf(res)) })
      // 상태 API 가 아직 없거나(404) 실패하면 단계를 모르는 채로 둔다.
      // 임의로 IDLE 로 단정하면 매핑 중인 화면이 옛 도면으로 바뀐다.
      .catch(() => { if (alive) setMappingPhase(null) })
    return () => { alive = false }
  }, [canConnect, accessToken])

  // 매핑에 '들어가는 순간' 에만 화면을 지운다. 매핑 중 매 갱신마다 지우면
  // 방금 받은 스냅샷까지 함께 날아가 지도가 영영 채워지지 않는다.
  const wasMappingRef = useRef(false)
  useEffect(() => {
    // 전용 신호(S15P11E101-747)가 우선이고, 없으면 텔레메트리 상태를 본다.
    const now = mappingPhase === PHASE_MAPPING
      || (mappingPhase == null && telemetry?.status === 'MAPPING')
    if (now && !wasMappingRef.current) resetMappingView()
    wasMappingRef.current = now
  }, [mappingPhase, telemetry?.status, resetMappingView])

  // 매핑 시작 대기 해제(S15P11E101). 로봇이 실제로 매핑에 들어갔거나(MAPPING) 완료되면
  // 대기 신호를 끈다 — 그때부터는 mapping/도면이 화면을 대신한다.
  useEffect(() => {
    const running = mappingPhase === PHASE_MAPPING
      || (mappingPhase == null && telemetry?.status === 'MAPPING')
    if (running || mappingComplete) setMappingStarting(false)
  }, [mappingPhase, telemetry?.status, mappingComplete])

  // 로봇이 시작에 응답하지 않아도 로딩이 영영 돌지 않도록 상한을 둔다(요청 거부·오프라인 대비).
  useEffect(() => {
    if (!mappingStarting) return undefined
    const id = setTimeout(() => setMappingStarting(false), 25000)
    return () => clearTimeout(id)
  }, [mappingStarting])

  // 활성 도면을 받아 온다(S15P11E101-524). 로그인 직후 한 번, 그리고 FLOORPLAN_READY 마다.
  // 이미지는 blob 으로 받아 objectURL 로 들고 있으므로 교체할 때 이전 것을 반드시 풀어야 한다.
  useEffect(() => {
    if (!canConnect) {
      setPlan((prev) => { releasePlan(prev); return null })
      navRef.current.plan = null
      setPlanError(null)
      return undefined
    }
    let alive = true
    loadActivePlan(accessToken)
      .then((next) => {
        if (!alive) { releasePlan(next); return }
        setPlan((prev) => { if (prev !== next) releasePlan(prev); return next })
        navRef.current.plan = next
        setPlanError(null)
        emitNav()
      })
      // 활성 맵이 아직 없으면 404 다 — 오류로 떠들지 않고 조용히 비워 둔다.
      .catch((e) => { if (alive) setPlanError(errMessage(e)) })
    return () => { alive = false }
  }, [canConnect, accessToken, planReady, emitNav])

  // 언마운트 시 마지막 objectURL 을 푼다
  useEffect(() => () => releasePlan(navRef.current.plan), [])

  // STOMP 가 인증을 거부하면 토큰이 죽은 것이다. 지금까지는 문구만 띄우고 화면에 남았다 —
  // 아무 데이터도 오지 않는 관제 화면을 계속 보여주는 것보다 로그인으로 보내는 편이 정직하다(S15P11E101-508).
  //
  // 다만 access 가 1시간짜리가 되면서(S15P11E101-608) 재연결 때 만료된 토큰으로 거부되는 일이
  // 흔해졌다. 먼저 갱신을 시도하고, 살아나면 setToken() 이 새 토큰으로 다시 붙는다.
  // 갱신 수단이 없거나 실패했을 때만 로그아웃한다.
  //
  // 갱신은 인증 거부 한 번에 한 번만 시도한다(S15P11E101-627). stompjs 는 2초마다 다시 붙으므로,
  // 거부가 이어지는 동안 매번 갱신하면 서버가 refresh 를 회전시키는 만큼 토큰이 계속 갈리고
  // 실서버에는 2초 간격 갱신 요청이 쌓인다(검증에서 11초에 8회를 봤다).
  // 새 토큰으로도 거부당하면 그때는 갱신으로 풀 수 없는 문제이므로 로그인으로 보낸다.
  const authRefreshed = useRef(false)
  const graceTimer = useRef<any>(null)
  useEffect(() => {
    // 연결이 살아나면 유예를 걷고 다음 사고를 위해 기회를 되돌려 준다
    if (connected && !authError) {
      authRefreshed.current = false
      clearTimeout(graceTimer.current); graceTimer.current = null
      return undefined
    }
    if (!authError || !accessToken) return undefined

    // 이미 갱신해 봤다 — 토큰 문제가 아니라 서버 쪽 문제일 수 있다.
    // 몇 초짜리 딸꾹질에 관제를 로그인으로 보내지 않고 유예 시간만큼 재연결을 기다린다.
    if (authRefreshed.current) {
      if (!graceTimer.current) {
        graceTimer.current = setTimeout(() => { logout(REASON.EXPIRED) }, STOMP_AUTH_GRACE_MS)
      }
      return undefined
    }
    authRefreshed.current = true
    let alive = true
    // 갱신 자체가 실패하면 토큰을 살릴 수 없다 — 그때는 곧바로 로그인으로 보낸다.
    refreshAccessToken().then((next) => {
      if (!alive) return
      if (!next) logout(REASON.EXPIRED)
    })
    return () => { alive = false }
  }, [authError, accessToken, connected, logout])
  useEffect(() => () => clearTimeout(graceTimer.current), [])

  const dismissAlert = useCallback((id: any) => {
    setAlerts((prev) => prev.filter((a) => a._id !== id))
  }, [])

  const onVideoFrame = useCallback((fn: any) => {
    videoListeners.current.add(fn)
    // 이미 받아둔 프레임이 있으면 즉시 1회 전달 (구독 시점 공백 방지)
    const cur = videoRef.current
    if (cur.FRONT) fn('FRONT', cur.FRONT)
    if (cur.THERMAL) fn('THERMAL', cur.THERMAL)
    return () => videoListeners.current.delete(fn)
  }, [])

  // 검출 박스 구독. onVideoFrame 과 같은 관례 — 등록 즉시 최신 것 1회 전달.
  const onDetections = useCallback((fn: (det: import('./contracts.d.ts').DetectionsMessage) => void) => {
    detListeners.current.add(fn)
    if (detRef.current) { try { fn(detRef.current) } catch { /* 무시 */ } }
    return () => detListeners.current.delete(fn)
  }, [])

  // 맵 캔버스가 구독한다. 구독 시점에 이미 받아둔 맵이 있으면 즉시 1회 전달해 공백을 막는다.
  const onNavUpdate = useCallback((fn: any) => {
    navListeners.current.add(fn)
    fn(navRef.current)
    return () => navListeners.current.delete(fn)
  }, [])

  // ---- 제어 발행 (가이드 §4) ----
  // 주행 속도는 ref로 들고 control 객체의 정체성을 고정한다. state로 바로 읽으면 속도를 바꿀 때마다
  // control 이 새로 만들어져 LiveSimBridge 의 키보드 effect 가 재등록되고 주행이 끊긴다.
  const speedRef = useRef(DEFAULT_DRIVE_SPEED)
  const [speed, setSpeedState] = useState(DEFAULT_DRIVE_SPEED)
  const setSpeed = useCallback((v: any) => { speedRef.current = v; setSpeedState(v) }, [])

  // 설정에서 상한을 낮추면 지금 속도가 범위를 벗어난다 — 새 범위 안으로 끌어온다.
  // 그대로 두면 슬라이더는 상한을 넘은 값을 표시하고 발행도 그 값으로 나간다.
  useEffect(() => {
    const clamped = clampDriveSpeed(speedRef.current, settings.vMax)
    if (clamped !== speedRef.current) setSpeed(clamped)
  }, [settings.vMax, setSpeed])

  const control = useMemo(() => {
    /**
     * 제어 명령 발행. body 는 판별 유니온이라 command 에 맞지 않는 필드를 실으면
     * 빌드에서 걸린다 — SET_MODE 에 linear 를 넣는 류의 실수를 여기서 막는다.
     * @param {'/app/control/drive' | '/app/control/mode' | '/app/control/operation' | '/app/control/camera'} dest
     * @param {import('./contracts').ControlCommandBody} body
     */
    const send = (dest: any, body: any) => publish(dest, /** @type {any} */ ({ robot_id: ROBOT_ID, ...body }))
    // 방향 단위벡터 × 축별 속도. 선속도는 슬라이더 값 그대로, 각속도는 같은 비율을
    // 각속도 상한에 적용한다 — 로봇 상한이 서로 달라(V/W) 한 배율을 공유하면 안 된다.
    // 부동소수 잔값이 payload 에 남지 않게 소수 2자리로 정리한다.
    const r2 = (v: any) => Number(v.toFixed(2))
    return {
      drive: (linear: any, angular: any) => send('/app/control/drive', {
        command: 'DRIVE',
        linear: r2(linear * speedRef.current),
        angular: r2(angular * angularFor(speedRef.current, vMaxRef.current, wMaxRef.current)),
      }),
      stop: () => send('/app/control/drive', { command: 'DRIVE', linear: 0, angular: 0 }),
      // mode: autonomy | manual | disabled 만 유효
      setMode: (mode: any) => send('/app/control/mode', { command: 'SET_MODE', mode }),
      // SET_MODE mode=disabled 로 ESTOP 명령 교체 (S15P11E101-732)
      estop: () => send('/app/control/mode', { command: 'SET_MODE', mode: 'disabled' }),
      navigate: (x: any, y: any, yaw = 0) => send('/app/control/operation', { command: 'NAVIGATE', x, y, yaw }),
      // 전면 카메라 상하 각도(S15P11E101-521). 절대각(도)으로 보낸다.
      //
      // 목적지는 /app/control/camera 다(S15P11E101-627). 예전에는 operation 으로 보냈는데
      // 서버의 operation 핸들러는 START_MAPPING/STOP_MAPPING/SAVE_MAP/NAVIGATE 만 받고
      // 나머지는 drop 한다 — 카메라 각도 명령이 서버에서 통째로 버려지고 있었다.
      // 서버가 가동범위로 클램프해 CAMERA_TILT 로 중계한다.
      setCameraTilt: (deg: any) => send('/app/control/camera', { command: TILT_COMMAND, tilt: deg }),
      // 자율 주행하며 2D 맵 생성 시작(S15P11E101-483).
      // BE 는 /app/control/operation 에서 이 명령을 로봇으로 릴레이한다.
      startMapping: () => { setMappingStarting(true); send('/app/control/operation', { command: 'START_MAPPING' }) },
      // 지금 만들어진 맵을 이름 붙여 저장한다(가이드 §5 SAVE_MAP) — 운영 탭에서 쓴다
      saveMap: (name: any) => send('/app/control/operation', { command: 'SAVE_MAP', name }),
      // 진행 중인 자율탐색 매핑 중단(S15P11E101-627). 로봇이 공장을 도는 중에 멈춰 세우는 명령이다.
      stopMapping: () => { setMappingStarting(false); send('/app/control/operation', { command: 'STOP_MAPPING' }) },
    }
  }, [])

  const clearMappingComplete = useCallback(() => setMappingComplete(null), [])

  // ---- 조종 점유: 파생 상태 · 수명주기 ----

  // 점유가 살아 있는 동안에만 돈다. 카운트다운과 무수신 판정을 다시 계산하는 용도다.
  useEffect(() => {
    if (!ownership.supported || !ownership.owner) return undefined
    const id = setInterval(() => setOwnershipTick((n) => (n + 1) % 100000), 250)
    return () => clearInterval(id)
  }, [ownership.supported, ownership.owner])

  const ownershipView = useMemo(() => {
    const now = Date.now()
    const mine = isMine(ownership, mySessionId)
    // 리스 2초 + 하트비트 500ms 를 넘겨 갱신이 끊기면 지금 값을 사실로 단언하지 않는다.
    const stale = isStale(ownership, now)
    return {
      supported: ownership.supported,
      owner: ownership.owner,
      ownerEmail: ownership.ownerEmail,
      event: ownership.event,
      claim: ownership.claim,
      denied: ownership.denied,
      mine,
      otherOwns: isOwnedByOther(ownership, mySessionId),
      leftMs: leftMsNow(ownership, now),
      stale,
    }
    // ownershipTick 은 시간이 흘렀다는 사실만 전달한다(값 자체는 쓰지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownership, mySessionId, ownershipTick])

  // 붙자마자 현재 점유를 한 번 물어본다. 점유가 비어 있으면 서버는 아무것도 보내지 않으므로
  // 이 요청이 없으면 "비었다" 를 영영 알 수 없다. 구독 프레임이 먼저 나가도록 살짝 미룬다.
  const liveConnected = enabled && connected
  useEffect(() => {
    if (!liveConnected) return undefined
    const id = setTimeout(() => sendOwnership('STATUS'), 200)
    return () => clearTimeout(id)
  }, [liveConnected, sendOwnership])

  // 갱신이 끊겨 "확인 중" 으로 내려갔으면 다시 물어본다(전환 시 1회).
  useEffect(() => {
    if (!liveConnected || !ownershipView.stale) return
    sendOwnership('STATUS')
  }, [liveConnected, ownershipView.stale, sendOwnership])

  // 남이 잡고 있거나 내 요청이 거부됐으면 수동 모드에 머무를 수 없다 — 즉시 순찰로 내린다.
  // (TAKEN_OVER_BY_OTHER 로 조이스틱을 잠그는 경로가 바로 이것이다)
  useEffect(() => {
    if (driveMode !== 'manual') return
    // 내 요청이 아직 왕복 중(pending)이면 판단을 미룬다 — 강제 탈취 직후 서버 응답이
    // 오기 전에 "남이 잡고 있다" 로 읽어 스스로 순찰로 튕겨 나가는 것을 막는다.
    if (ownershipView.claim === 'pending') return
    if (ownershipView.claim === 'denied' || ownershipView.otherOwns) setDriveMode('patrol')
  }, [driveMode, ownershipView.claim, ownershipView.otherOwns])

  // 수동 모드에 있는 동안 점유를 잡고 유지한다.
  //
  // 서버 리스는 2초이고 제어 명령이 올 때마다 갱신된다. 조작자가 잠시 키를 놓으면
  // 리스가 만료돼 남이 끼어들 수 있으므로, 수동 모드인 동안은 700ms 마다 ACQUIRE 를 보내
  // 리스를 살려 둔다(내 것이면 서버는 RENEWED 로 처리하고 방송조차 하지 않는다).
  //
  // 정리 시 RELEASE 는 '내가 소유자일 때만' 보낸다 — 관전만 하던 탭이 남의 조종을
  // 끊어 버리는 사고를 막는다.
  //
  // canOperate 를 조건에 넣는 이유: 700ms 갱신은 사람이 자리를 비워도 계속 돌아 사실상
  // 무기한 점유가 된다. 유휴 조작 잠금(S15P11E101-653)이 걸리면 그 사람은 이미 조작할 수
  // 없는 상태이므로, 그때는 점유도 함께 놓아 다른 사람이 들어올 수 있게 한다.
  const holdOwnership = liveConnected && driveMode === 'manual' && canOperate
  useEffect(() => {
    if (!holdOwnership) return undefined
    sendOwnership('ACQUIRE')
    const id = setInterval(() => {
      if (ownershipRef.current.claim === 'denied') return
      sendOwnership('ACQUIRE')
    }, OWNERSHIP_KEEPALIVE_MS)
    return () => {
      clearInterval(id)
      if (isMine(ownershipRef.current, mySessionIdRef.current)) sendOwnership('RELEASE')
    }
  }, [holdOwnership, sendOwnership])

  // 조작 권한이 사라졌는데(유휴 잠금·권한 회수) 화면만 수동 모드로 남아 있으면 거짓말이다.
  // 위 effect 가 이미 점유를 놓았으므로 토글도 순찰로 되돌린다.
  useEffect(() => {
    if (!canOperate && driveMode === 'manual') setDriveMode('patrol')
  }, [canOperate, driveMode])

  const controlOwnership = useMemo(() => ({
    acquire: () => sendOwnership('ACQUIRE'),
    // 파괴적 동작 — 호출하는 쪽(ControlPanel)이 확인 절차를 거친 뒤에만 부른다
    takeover: () => sendOwnership('TAKEOVER'),
    release: () => {
      if (isMine(ownershipRef.current, mySessionIdRef.current)) sendOwnership('RELEASE')
    },
    requestStatus: () => sendOwnership('STATUS'),
    clearDenied: () => applyOwnership({ ...ownershipRef.current, denied: null }),
  }), [sendOwnership, applyOwnership])

  const value = useMemo(() => ({
    enabled, connected, lastError, authError, hasToken: !!accessToken,
    dataSource, setDataSource, toggleDataSource,
    telemetry, alerts, dismissAlert,
    onVideoFrame, onDetections, onNavUpdate, videoSeen, control, robotId: ROBOT_ID,
    speed, setSpeed,
    mappingComplete, clearMappingComplete, robotOnline,
    mappingPhase, mapping: mappingPhase === PHASE_MAPPING || (mappingPhase == null && telemetry?.status === 'MAPPING'),
    mappingStarting,
    resetMappingView,
    driveMode, setDriveMode,
    plan, planError,
    ownership: ownershipView, controlOwnership, mySessionId,
  }), [enabled, connected, lastError, authError, accessToken, dataSource, setDataSource,
      toggleDataSource, telemetry, alerts, dismissAlert, onVideoFrame, onDetections, onNavUpdate,
      videoSeen, control, speed, setSpeed, mappingComplete, clearMappingComplete, robotOnline,
      mappingPhase, mappingStarting, resetMappingView, driveMode, setDriveMode, plan, planError,
      ownershipView, controlOwnership, mySessionId])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
