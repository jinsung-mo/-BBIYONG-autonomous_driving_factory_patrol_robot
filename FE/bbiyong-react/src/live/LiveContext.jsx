// 실서버(STOMP) 연동 컨텍스트 — docs/fe_backend_integration_guide.md §3·§4 구현.
//
// 로컬 시뮬레이션(SimContext)은 그대로 두고 그 위에 얹는다. 컴포넌트는 live 모드일 때만
// 이쪽 값을 쓰고, mock 모드에서는 기존 시뮬 동작이 100% 유지된다.
//
// 주의: CCTV 관제 화면(PTZ·신뢰도 차트)은 백엔드 계약이 없어 live 모드에서도 시뮬로 동작한다.
// 가이드가 정의하는 실서버 구간은 순찰 로봇(텔레메트리·경보·영상·제어)뿐이다.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ROBOT_ID, getDataSource, saveDataSource } from './config.js'
import { connect, disconnect, subscribe, publish, onState } from './stompClient.js'
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

  // ---- 연결 · 구독 (live 모드에서만) ----
  useEffect(() => {
    if (!enabled) {
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
    // 토큰이 없어도 시도는 한다 — 인증 강제(S15P11E101-418) 배포 전 서버는 토큰을 무시하므로
    // 지금은 붙고, 배포 후에는 ERROR 프레임으로 거부되어 authError로 드러난다.
    connect(accessToken)

    return () => {
      clearInterval(flush)
      offRobots(); offAlerts(); offVideo(); offState()
      disconnect()
    }
  }, [enabled, accessToken])

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
  const control = useMemo(() => {
    const send = (dest, body) => publish(dest, { robot_id: ROBOT_ID, ...body })
    return {
      drive: (linear, angular) => send('/app/control/drive', { command: 'DRIVE', linear, angular }),
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
  }), [enabled, connected, lastError, authError, accessToken, dataSource, setDataSource,
      toggleDataSource, telemetry, alerts, dismissAlert, onVideoFrame, control])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
