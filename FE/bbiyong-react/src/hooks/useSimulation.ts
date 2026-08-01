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
  const [activeKeys, setActiveKeys] = useState<Record<string, boolean>>({ w: false, a: false, s: false, d: false })
  const [theme, setTheme] = useState('dark') // 'dark' | 'light'

  // 구독 + 루프 시작/정리
  useEffect(() => {
    const unsub = sim.subscribe(setStatus)
    sim.start()
    const clockTimer = setInterval(() => {
      setClock(new Date().toLocaleString('ko-KR', { hour12: false }))
    }, 1000)
    return () => { unsub(); sim.stop(); clearInterval(clockTimer) }
  }, [sim])

  // 테마를 <html data-theme>에 반영
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  // 키보드 WASD + 방향키 — 로봇 이동
  useEffect(() => {
    const arrowMap: Record<string, string> = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' }
    const resolve = (e: any) => {
      let key = e.key.toLowerCase()
      if (arrowMap[key]) { key = arrowMap[key]; e.preventDefault() } // 방향키 → WASD, 페이지 스크롤 방지
      return 'wasd'.includes(key) ? key : null
    }
    const onDown = (e: any) => {
      const key = resolve(e)
      if (!key) return
      setActiveKeys((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
      sim.dpadMove(key)
    }
    const onUp = (e: any) => {
      const key = resolve(e)
      if (!key) return
      setActiveKeys((prev) => ({ ...prev, [key]: false }))
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
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
  }), [sim])

  return { status, clock, activeKeys, refs, actions, theme, toggleTheme }
}
