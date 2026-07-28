import { useEffect, useRef, useState } from 'react'
import { useSim } from '../SimContext.js'
import { useLive } from '../live/LiveContext.jsx'
import { alertToToast } from '../live/mappers.js'

// 화재/과열 팝업 알림. 화면 상단에 배너로 뜨며, 떠 있는 동안 경보음이 반복 재생된다.
//
// - mock 모드: 시뮬레이션의 fireOn/heatOn "발생 순간" 전이로 생성.
//   ✕ 로 닫으면 경보 원인(화재/과열)도 함께 해제한다.
// - live 모드: /topic/alerts 수신으로 생성. 서버 경보는 one-shot이라 "해제" 이벤트가 없으므로
//   ✕ 는 토스트만 닫는다(가이드 §4·§6).

// 현재 편성된 순찰 로봇 — 출동 대상은 이 1대뿐 (StatusPanel의 표기와 동일)
const ROBOT_NAME = '오린카-01'

const SOUND_REPEAT_MS = 3000 // 알림이 떠 있는 동안 경보음 반복 간격
let uid = 0

// 오디오 파일 없이 오실레이터로 경보음 생성 (화재: 높은 삐-삐-삐 / 과열: 낮은 삐-삐)
function playAlarmBeep(kind) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const freqs = kind === 'fire' ? [880, 660, 880] : [520, 440]
    let t = now
    freqs.forEach((freq) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.24)
      t += 0.26
    })
    setTimeout(() => ctx.close(), (t - now + 0.3) * 1000)
  } catch {
    // 오디오 미지원/차단 환경 — 무시 (팝업은 그대로 뜬다)
  }
}

// 떠 있는 토스트 목록에 맞춰 반복 경보음 타이머를 붙였다 뗀다.
function useAlarmSound(items) {
  const timers = useRef({})
  useEffect(() => {
    const alive = new Set(items.map((i) => String(i.id)))
    items.forEach((i) => {
      if (!timers.current[i.id]) {
        playAlarmBeep(i.kind)
        timers.current[i.id] = setInterval(() => playAlarmBeep(i.kind), SOUND_REPEAT_MS)
      }
    })
    Object.keys(timers.current).forEach((k) => {
      if (!alive.has(k)) { clearInterval(timers.current[k]); delete timers.current[k] }
    })
  }, [items])
  // 언마운트 시 남은 타이머 정리
  useEffect(() => () => { Object.values(timers.current).forEach(clearInterval) }, [])
}

function ToastList({ items, onDismiss }) {
  useAlarmSound(items)
  if (items.length === 0) return null
  return (
    <div className="alert-toast-wrap" role="alert" aria-live="assertive">
      {items.map((a) => (
        <div key={a.id} className={`alert-toast ${a.kind}`}>
          <div className="alert-toast-text">
            <span className="alert-toast-title">{a.title}</span>
            {a.sub && <span className="alert-toast-sub">{a.sub}</span>}
          </div>
          <span className="alert-toast-time mono">{a.time}</span>
          <button className="alert-toast-x" aria-label="닫기" onClick={() => onDismiss(a.id)}>✕</button>
        </div>
      ))}
    </div>
  )
}

// ---- live: /topic/alerts 수신분을 그대로 렌더 ----
function LiveAlerts() {
  const { alerts, dismissAlert } = useLive()
  const items = alerts.map((a) => ({ id: a._id, ...alertToToast(a) }))
  return <ToastList items={items} onDismiss={dismissAlert} />
}

// ---- mock: 시뮬레이션 전이로 생성 (기존 동작 유지) ----
function SimAlerts() {
  const { status, actions } = useSim()
  const [alerts, setAlerts] = useState([])
  const prevFire = useRef(status.fireOn)
  const prevHeat = useRef(status.heatOn)

  const pushAlert = (kind, title, sub) => {
    const id = ++uid
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false })
    setAlerts((prev) => [...prev, { id, kind, title, time, sub }])
  }

  const dismissKind = (kind) => setAlerts((prev) => prev.filter((a) => a.kind !== kind))

  // 꺼짐→켜짐으로 바뀌는 "발생 순간"에만 알림 생성, 켜짐→꺼짐 순간 자동 종료
  // 화재는 실제로 오린카가 긴급 출동하므로(Simulation.setFire → botGoto), 출동 로봇을 함께 표시
  useEffect(() => {
    if (status.fireOn && !prevFire.current) pushAlert('fire', '🔥 화재 발생', `🤖 ${ROBOT_NAME} 긴급 출동 중`)
    if (!status.fireOn && prevFire.current) dismissKind('fire')
    prevFire.current = status.fireOn
  }, [status.fireOn])

  useEffect(() => {
    if (status.heatOn && !prevHeat.current) pushAlert('heat', '⚠ 분전반 과열 의심')
    if (!status.heatOn && prevHeat.current) dismissKind('heat')
    prevHeat.current = status.heatOn
  }, [status.heatOn])

  // ✕로 닫으면 알림만 없애는 게 아니라, 해당 경보 원인(화재/과열)도 함께 해제한다.
  const dismiss = (id) => {
    const target = alerts.find((a) => a.id === id)
    setAlerts((prev) => prev.filter((a) => a.id !== id))
    if (target?.kind === 'fire' && status.fireOn) actions.toggleFire()
    if (target?.kind === 'heat' && status.heatOn) actions.toggleHeat()
  }

  return <ToastList items={alerts} onDismiss={dismiss} />
}

export default function EventAlert() {
  const { enabled } = useLive()
  return enabled ? <LiveAlerts /> : <SimAlerts />
}
