import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Simulation from '../sim/Simulation.ts'

// Simulation 인스턴스를 만들고 rAF 루프 생명주기를 관리하며,
// 상태 스냅샷·시계·키보드(WASD)·캔버스 ref·액션을 React에 노출한다.
export default function useSimulation() {
  const simRef = useRef<any>(null)
  if (simRef.current === null) simRef.current = new Simulation()
  const sim = simRef.current

  const [status, setStatus] = useState(() => sim.snapshot())
  const [clock, setClock] = useState('--:--:--')

  // 구독 + 루프 시작/정리
  useEffect(() => {
    const unsub = sim.subscribe(setStatus)
    sim.start()
    const clockTimer = setInterval(() => {
      setClock(new Date().toLocaleString('ko-KR', { hour12: false }))
    }, 1000)
    return () => { unsub(); sim.stop(); clearInterval(clockTimer) }
  }, [sim])

  // 테마 전환은 걷어냈다(S15P11E101-805). `data-theme="light"` 는 main.tsx 가 첫 페인트
  // 전에 상수로 붙인다 — 라이트 대비 보정 규칙(`:root[data-theme="light"] …`)이 매칭돼야 한다.

  // 키보드 WASD — 로봇 이동 (위/아래 방향키는 카메라 틸트 전용)
  useEffect(() => {
    const resolve = (e: any) => {
      const key = e.key.toLowerCase()
      return /^[wasd]$/.test(key) ? key : null
    }
    const isTyping = (el: any) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
    const onDown = (e: any) => {
      if (isTyping(e.target)) return
      const key = resolve(e)
      if (!key) return
      if (sim.snapshot().seg !== 'manual') return
      sim.dpadMove(key)
    }
    window.addEventListener('keydown', onDown)
    return () => window.removeEventListener('keydown', onDown)
  }, [sim])

  // 캔버스 콜백 ref (마운트 시 sim에 등록)
  // 언마운트 시 el 이 null 로 들어온다 — 그대로 넘겨 등록을 해제한다.
  // (live 모드에서 2D 맵 캔버스가 빠질 때 떨어져 나간 엘리먼트를 계속 그리려 하면 안 된다)
  const canvasRef = useCallback((name: any) => (el: any) => sim.registerCanvas(name, el), [sim])
  const refs = useMemo(() => ({
    rcam: canvasRef('rcam'),
    tcam: canvasRef('tcam'),
    map2d: canvasRef('map2d'),
  }), [canvasRef])

  // UI 액션 (버튼/스위치가 호출)
  const actions = useMemo(() => ({
    toggleFire: () => sim.toggleFire(),
    toggleHeat: () => sim.toggleHeat(),
    toggleSound: () => sim.toggleSound(),
    setSeg: (man: any) => sim.segSet(man),
    dpadMove: (dir: any) => sim.dpadMove(dir),
    dpStop: () => sim.dpStop(),
    emergencyStop: () => sim.emergencyStop(),
    reset: () => sim.reset(),
    returnPatrol: () => sim.returnPatrol(),
    goto: (value: any, label: any) => sim.goto(value, label),
    setManualSpeed: (v: any) => sim.setManualSpeed(v),
    setTempThresholds: (w: any, c: any) => sim.setTempThresholds(w, c),
    // live 모드 외부 입력 (LiveSimBridge 가 텔레메트리·영상 프레임을 밀어 넣는다)
    setExternalPose: (pose: any) => sim.setExternalPose(pose),
    setExternalFrame: (ch: any, img: any, maxTemp: any) => sim.setExternalFrame(ch, img, maxTemp),
    clearExternalFrames: () => sim.clearExternalFrames(),
    // 시뮬 이벤트 로그에 한 줄 남긴다 — 조작 잠금·해제 기록에 쓴다(S15P11E101-653)
    pushLog: (kind: any, msg: any) => sim.pushLog(kind, msg),
  }), [sim])

  return { status, clock, refs, actions }
}
