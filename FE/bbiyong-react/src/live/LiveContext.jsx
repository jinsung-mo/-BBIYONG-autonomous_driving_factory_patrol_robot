// 실서버(STOMP) 연동 컨텍스트 — docs/fe_backend_integration_guide.md §3·§4 구현.
//
// 로컬 시뮬레이션(SimContext)은 그대로 두고 그 위에 얹는다. 컴포넌트는 live 모드일 때만
// 이쪽 값을 쓰고, mock 모드에서는 기존 시뮬 동작이 100% 유지된다.
//
// 가이드가 정의하는 실서버 구간은 순찰 로봇(텔레메트리·경보·영상·제어)뿐이다.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ROBOT_ID, getDataSource, saveDataSource } from './config.js'
import { connect, disconnect, subscribe, publish, onState, setToken } from './stompClient.js'
import { DEFAULT_DRIVE_SPEED } from './mappers.js'
import { useAuth } from '../auth/AuthContext.jsx'

const LiveContext = createContext(null)

export function useLive() {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used within <LiveProvider>')
  return ctx
}

// 텔레메트리는 연속 변동값 → 기존 시뮬(400ms emit)과 같은 취지로 주기 플러시해 리렌더를 억제한다.
const TELEMETRY_FLUSH_MS = 250

let alertUid = 0

export function LiveProvider({ children }) {
  const { accessToken } = useAuth()
  const [dataSource, setDataSourceState] = useState(getDataSource)
  const enabled = dataSource === 'live'

  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState(null)
  const [authError, setAuthError] = useState(false)
  const [telemetry, setTelemetry] = useState(null)
  const [alerts, setAlerts] = useState([])

  // 영상 프레임은 초당 수십 장이 들어올 수 있어 React state로 올리지 않는다.
  // ref에 최신 프레임만 두고, 캔버스를 그리는 쪽이 리스너로 직접 받아간다.
  const videoRef = useRef({ FRONT: null, THERMAL: null })
  const videoListeners = useRef(new Set())

  const telemetryRef = useRef(null)

  const setDataSource = useCallback((value) => {
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
      videoRef.current = { FRONT: null, THERMAL: null }
      disconnect()
      return undefined
    }

    const offState = onState(({ connected: c, lastError: e, authError: a }) => {
      setConnected(c); setLastError(e); setAuthError(!!a)
    })

    const offRobots = subscribe('/topic/robots', (msg) => { telemetryRef.current = msg })

    const offAlerts = subscribe('/topic/alerts', (msg) => {
      // 서버 경보는 one-shot — 대응하는 "해제" 이벤트가 없다(가이드 §4).
      setAlerts((prev) => [...prev, { ...msg, _id: ++alertUid }])
    })

    const offVideo = subscribe(`/topic/video/${ROBOT_ID}`, (frame) => {
      const ch = frame?.channel
      if (ch !== 'FRONT' && ch !== 'THERMAL') return
      videoRef.current[ch] = frame
      videoListeners.current.forEach((fn) => fn(ch, frame))
    })

    const flush = setInterval(() => {
      if (telemetryRef.current) setTelemetry(telemetryRef.current)
    }, TELEMETRY_FLUSH_MS)

    // CONNECT 프레임에 JWT를 실어 연결한다(가이드 §1).
    // 인증 강제(S15P11E101-418)가 배포되어, 토큰이 없거나 무효면 ERROR 프레임으로 거부된다.
    connect()

    return () => {
      clearInterval(flush)
      offRobots(); offAlerts(); offVideo(); offState()
      disconnect()
    }
  }, [canConnect])

  const dismissAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((a) => a._id !== id))
  }, [])

  const onVideoFrame = useCallback((fn) => {
    videoListeners.current.add(fn)
    // 이미 받아둔 프레임이 있으면 즉시 1회 전달 (구독 시점 공백 방지)
    const cur = videoRef.current
    if (cur.FRONT) fn('FRONT', cur.FRONT)
    if (cur.THERMAL) fn('THERMAL', cur.THERMAL)
    return () => videoListeners.current.delete(fn)
  }, [])

  // ---- 제어 발행 (가이드 §4) ----
  // 주행 속도는 ref로 들고 control 객체의 정체성을 고정한다. state로 바로 읽으면 속도를 바꿀 때마다
  // control 이 새로 만들어져 LiveSimBridge 의 키보드 effect 가 재등록되고 주행이 끊긴다.
  const speedRef = useRef(DEFAULT_DRIVE_SPEED)
  const [speed, setSpeedState] = useState(DEFAULT_DRIVE_SPEED)
  const setSpeed = useCallback((v) => { speedRef.current = v; setSpeedState(v) }, [])

  const control = useMemo(() => {
    const send = (dest, body) => publish(dest, { robot_id: ROBOT_ID, ...body })
    // 방향 단위벡터 × 주행 속도 — 부동소수 잔값이 payload에 남지 않게 소수 2자리로 정리한다
    const scale = (v) => Number((v * speedRef.current).toFixed(2))
    return {
      drive: (linear, angular) => send('/app/control/drive', { command: 'DRIVE', linear: scale(linear), angular: scale(angular) }),
      stop: () => send('/app/control/drive', { command: 'DRIVE', linear: 0, angular: 0 }),
      // mode: autonomy | manual | disabled 만 유효
      setMode: (mode) => send('/app/control/mode', { command: 'SET_MODE', mode }),
      // fail-safe — active:true 만 허용(해제 명령 없음)
      estop: () => send('/app/control/mode', { command: 'ESTOP', active: true }),
      navigate: (x, y, yaw = 0) => send('/app/control/operation', { command: 'NAVIGATE', x, y, yaw }),
    }
  }, [])

  const value = useMemo(() => ({
    enabled, connected, lastError, authError, hasToken: !!accessToken,
    dataSource, setDataSource, toggleDataSource,
    telemetry, alerts, dismissAlert,
    onVideoFrame, control, robotId: ROBOT_ID,
    speed, setSpeed,
  }), [enabled, connected, lastError, authError, accessToken, dataSource, setDataSource,
      toggleDataSource, telemetry, alerts, dismissAlert, onVideoFrame, control, speed, setSpeed])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
