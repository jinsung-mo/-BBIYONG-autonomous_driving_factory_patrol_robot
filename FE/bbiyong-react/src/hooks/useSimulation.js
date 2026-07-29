import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Simulation from '../sim/Simulation.js'

// Simulation 인스턴스를 만들고 rAF 루프 생명주기를 관리하며,
// 상태 스냅샷·시계·키보드(WASD)·캔버스 ref·액션을 React에 노출한다.
export default function useSimulation() {
  const simRef = useRef(null)
  if (simRef.current === null) simRef.current = new Simulation()
  const sim = simRef.current

  const [status, setStatus] = useState(() => sim.snapshot())
  const [clock, setClock] = useState('--:--:--')
  const [activeKeys, setActiveKeys] = useState({ w: false, a: false, s: false, d: false })
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
    const arrowMap = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' }
    const resolve = (e) => {
      let key = e.key.toLowerCase()
      if (arrowMap[key]) { key = arrowMap[key]; e.preventDefault() } // 방향키 → WASD, 페이지 스크롤 방지
      return 'wasd'.includes(key) ? key : null
    }
    const onDown = (e) => {
      const key = resolve(e)
      if (!key) return
      setActiveKeys((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
      sim.dpadMove(key)
    }
    const onUp = (e) => {
      const key = resolve(e)
      if (!key) return
      setActiveKeys((prev) => ({ ...prev, [key]: false }))
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [sim])

  // 캔버스 콜백 ref (마운트 시 sim에 등록)
  const canvasRef = useCallback((name) => (el) => { if (el) sim.registerCanvas(name, el) }, [sim])
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
    setSeg: (man) => sim.segSet(man),
    dpadMove: (dir) => sim.dpadMove(dir),
    dpStop: () => sim.dpStop(),
    emergencyStop: () => sim.emergencyStop(),
    reset: () => sim.reset(),
    returnPatrol: () => sim.returnPatrol(),
    goto: (value, label) => sim.goto(value, label),
    // live 모드 외부 입력 (LiveSimBridge 가 텔레메트리·영상 프레임을 밀어 넣는다)
    setExternalPose: (pose) => sim.setExternalPose(pose),
    setExternalFrame: (ch, img, maxTemp) => sim.setExternalFrame(ch, img, maxTemp),
    clearExternalFrames: () => sim.clearExternalFrames(),
  }), [sim])

  return { status, clock, activeKeys, refs, actions, theme, toggleTheme }
}
