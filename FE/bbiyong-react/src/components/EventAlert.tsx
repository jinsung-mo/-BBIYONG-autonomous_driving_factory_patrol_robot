import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSim } from '../SimContext.ts'
import { useLive } from '../live/LiveContext.tsx'
import { alertToToast } from '../live/mappers.ts'
import FireFlash from './FireFlash.tsx'
import { acknowledgeFire, fireKey, raiseFire } from '../live/fireAlarm.ts'

// 화재/과열 팝업 알림. 화면 상단에 배너로 뜨며, 떠 있는 동안 경보음이 반복 재생된다.
//
// - mock 모드: 시뮬레이션의 fireOn/heatOn "발생 순간" 전이로 생성.
//   ✕ 로 닫으면 경보 원인(화재/과열)도 함께 해제한다.
// - live 모드: /topic/alerts 수신으로 생성. 서버 경보는 one-shot이라 "해제" 이벤트가 없으므로
//   ✕ 는 토스트만 닫는다(가이드 §4·§6).
//
// 화재는 여기에 더해 화면 전체를 점멸시킨다(S15P11E101-643). 점멸은 [확인]으로만 멈춘다 —
// ✕ 는 알림을 치우는 것이지 화재를 봤다는 뜻이 아니다. 과열은 점멸 대상이 아니다.

// 현재 편성된 순찰 로봇 — 출동 대상은 이 1대뿐 (StatusPanel의 표기와 동일)
const ROBOT_NAME = 'orinka_01'

const SOUND_REPEAT_MS = 3000 // 알림이 떠 있는 동안 경보음 반복 간격
let uid = 0

// 오디오 파일 없이 오실레이터로 경보음 생성 (화재: 높은 삐-삐-삐 / 과열: 낮은 삐-삐)
function playAlarmBeep(kind: any) {
  try {
    // webkitAudioContext 는 구형 Safari 폴백이라 표준 타입에 없다. 런타임 동작은 그대로 두고
    // 타입만 넓힌다(S15P11E101-570).
    const w = window as any
    const AudioCtx = w.AudioContext || w.webkitAudioContext
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
function useAlarmSound(items: any) {
  const timers = useRef<Record<string, any>>({})
  useEffect(() => {
    const alive = new Set(items.map((i: any) => String(i.id)))
    items.forEach((i: any) => {
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
  // Object.values 가 unknown[] 을 주므로 타이머 핸들 타입을 명시한다
  useEffect(() => () => {
    Object.values(timers.current as Record<string, number>).forEach(clearInterval)
  }, [])
}

function ToastList({ items, onDismiss, onAck }: any) {
  useAlarmSound(items)
  if (items.length === 0) return null
  return (
    <div className="alert-toast-wrap" role="alert" aria-live="assertive">
      {items.map((a: any) => (
        <div key={a.id} className={`alert-toast ${a.kind}`}>
          <div className="alert-toast-text">
            <span className="alert-toast-title">{a.title}</span>
            {a.sub && <span className="alert-toast-sub">{a.sub}</span>}
          </div>
          <span className="alert-toast-time mono">{a.time}</span>
          {/* 화재는 여기서 바로 확인할 수 있게 한다 — ✕ 를 찾아 누르게 만들 상황이 아니다 */}
          {a.kind === 'fire' && (
            <button
              type="button"
              className="alert-toast-ack"
              id="btnToastFireAck"
              aria-label="화재 경보 확인 — 경보음과 화면 점멸을 멈춥니다"
              onClick={onAck}
            >
              확인
            </button>
          )}
          <button className="alert-toast-x" aria-label="닫기" onClick={() => onDismiss(a.id)}>✕</button>
        </div>
      ))}
    </div>
  )
}

// ---- live: /topic/alerts 수신분을 그대로 렌더 ----
function LiveAlerts() {
  const { alerts } = useLive()
  // 팝업을 닫은 사실과 이벤트 이력은 다른 상태다. alerts 를 지우면 LogList 의
  // 실시간 행도 함께 사라지므로, 이 컴포넌트 안에서만 닫힌 팝업 ID 를 보관한다.
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<number>>(() => new Set())
  // 매 렌더마다 새 배열이 되면 경보음 타이머 동기화 effect가 불필요하게 재실행된다
  const items = useMemo(() => alerts
    .filter((a: any) => !dismissedAlertIds.has(a._id))
    .map((a: any) => ({ id: a._id, ...alertToToast(a) })), [alerts, dismissedAlertIds])

  // 화재 경보가 오면 미확인 상태로 올린다. 같은 경보를 두 번 올리지 않는 판단은
  // fireAlarm 이 키로 한다 — 여기서는 도착한 것을 그대로 넘기면 된다.
  useEffect(() => {
    alerts.forEach((a: any) => { if (a?.type === 'FIRE') raiseFire(fireKey(a)) })
  }, [alerts])

  const dismissToast = useCallback((id: number) => {
    setDismissedAlertIds((prev) => new Set(prev).add(id))
  }, [])

  // 확인 = 점멸 정지 + 화재 토스트 정리(경보음도 함께 멎는다).
  // 이벤트 이력용 alerts 는 유지한다 — 해결 처리는 이벤트 상세의 몫이다(S15P11E101-593/628).
  const ack = useCallback(() => {
    acknowledgeFire()
    setDismissedAlertIds((prev) => {
      const next = new Set(prev)
      alerts.forEach((a: any) => { if (a?.type === 'FIRE') next.add(a._id) })
      return next
    })
  }, [alerts])

  return <>
    <ToastList items={items} onDismiss={dismissToast} onAck={ack} />
    <FireFlash onAck={ack} />
  </>
}

// ---- mock: 시뮬레이션 전이로 생성 (기존 동작 유지) ----
function SimAlerts() {
  const { status, actions } = useSim()
  const [alerts, setAlerts] = useState<any[]>([])
  const prevFire = useRef(status.fireOn)
  const prevHeat = useRef(status.heatOn)

  // sub 는 과열 경보에서 생략한다 — 설비·온도는 토스트 본문이 아니라 이벤트 로그에 남는다
  const pushAlert = (kind: string, title: string, sub?: string) => {
    const id = ++uid
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false })
    setAlerts((prev) => [...prev, { id, kind, title, time, sub }])
  }

  const dismissKind = (kind: any) => setAlerts((prev) => prev.filter((a) => a.kind !== kind))

  // 꺼짐→켜짐으로 바뀌는 "발생 순간"에만 알림 생성, 켜짐→꺼짐 순간 자동 종료
  // 화재는 실제로 오린카가 긴급 출동하므로(Simulation.setFire → botGoto), 출동 로봇을 함께 표시
  useEffect(() => {
    if (status.fireOn && !prevFire.current) {
      pushAlert('fire', '화재 발생', `${ROBOT_NAME} 긴급 출동 중`)
      // 시연에서도 실제와 같이 화면이 점멸해야 한다. 발생 순간마다 새 키를 준다.
      raiseFire(`sim:${++uid}`)
    }
    if (!status.fireOn && prevFire.current) dismissKind('fire')
    prevFire.current = status.fireOn
  }, [status.fireOn])

  useEffect(() => {
    if (status.heatOn && !prevHeat.current) pushAlert('heat', '과열 감지')
    if (!status.heatOn && prevHeat.current) dismissKind('heat')
    prevHeat.current = status.heatOn
  }, [status.heatOn])

  // ✕로 닫으면 알림만 없애는 게 아니라, 해당 경보 원인(화재/과열)도 함께 해제한다.
  const dismiss = (id: any) => {
    const target = alerts.find((a) => a.id === id)
    setAlerts((prev) => prev.filter((a) => a.id !== id))
    if (target?.kind === 'fire' && status.fireOn) actions.toggleFire()
    if (target?.kind === 'heat' && status.heatOn) actions.toggleHeat()
  }

  // 확인은 화재를 끄지 않는다 — 봤다는 표시일 뿐이라 시뮬레이션의 fireOn 은 그대로 둔다.
  const ack = () => {
    acknowledgeFire()
    setAlerts((prev) => prev.filter((a) => a.kind !== 'fire'))
  }

  return <>
    <ToastList items={alerts} onDismiss={dismiss} onAck={ack} />
    <FireFlash onAck={ack} />
  </>
}

export default function EventAlert() {
  const { enabled } = useLive()
  return enabled ? <LiveAlerts /> : <SimAlerts />
}
