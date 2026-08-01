import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLive } from './LiveContext.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { fetchDashboardStats } from './dashboard.ts'
import { listEquipments } from './equipments.ts'
import { eqId } from './equipments.ts'
import { errMessage } from './errors.ts'

type Stats = import('./contracts.d.ts').DashboardStats
type Robot = import('./contracts.d.ts').RobotResponse
type Equipment = import('./contracts.d.ts').Equipment

// 편성(fleet) 상태를 한 곳에서 받아 나눠 쓴다 — S15P11E101-591.
//
// GET /api/dashboard/stats 는 요약 숫자와 함께 로봇 전 대수의 상태(robotStatus)를 준다.
// 요약 띠·로봇 현황·조회 대상 선택이 모두 이 응답을 쓰므로, 컴포넌트마다 따로 부르면
// 같은 것을 세 번 긁는다. 한 번 받아 컨텍스트로 내린다.
//
// 조회 대상 로봇(selected)은 **조회에만** 쓴다. 주행·E-STOP 같은 제어는 STOMP 토픽이
// 로봇마다 갈리고 LiveContext 가 ROBOT_ID 하나에 붙어 있으므로 여전히 ROBOT_ID 로 나간다.
// 이 구분이 흐려지면 다른 로봇을 보면서 이 로봇을 조작하는 사고가 난다 — 화면에도 명시한다.
const REFRESH_MS = 30000

export interface FleetContextValue {
  stats: Stats | null
  /** 서버가 보고한 로봇 목록. 비어 있으면 아직 못 받았거나 편성이 없다. */
  robots: Robot[]
  /** 조회 대상 로봇 id. 제어 대상이 아니다. */
  selected: string
  setSelected: (id: string) => void
  /** 로봇이 2대 이상일 때만 고를 의미가 있다 */
  multi: boolean
  /** id → 표시 이름. 못 찾으면 id 를 그대로 돌려준다(빈 라벨을 만들지 않는다). */
  robotName: (id: string | null | undefined) => string
  equipments: Equipment[]
  equipmentName: (id: string | null | undefined) => string
  error: string | null
  reload: () => void
}

const FleetContext = createContext<FleetContextValue | null>(null)

export function useFleet(): FleetContextValue {
  const v = useContext(FleetContext)
  if (!v) throw new Error('useFleet 은 FleetProvider 안에서만 쓸 수 있다')
  return v
}

export function FleetProvider({ children }: { children?: import('react').ReactNode }) {
  const { enabled, robotId } = useLive()
  const { accessToken } = useAuth()

  const [stats, setStats] = useState<Stats | null>(null)
  const [equipments, setEquipments] = useState<Equipment[]>([])
  const [error, setError] = useState<string | null>(null)
  // 초기값은 제어 대상과 같게 둔다 — 고르기 전까지는 지금 보고 있는 로봇이 곧 조회 대상이다
  const [selected, setSelected] = useState(robotId)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    try {
      const res = await fetchDashboardStats(accessToken)
      if (!alive.current) return
      setStats(res); setError(null)
    } catch (e) {
      // 갱신 실패로 직전 값을 지우지 않는다 — 낡은 수치가 빈 칸보다 낫다
      if (alive.current) setError(errMessage(e))
    }
  }, [enabled, accessToken])

  useEffect(() => {
    load()
    if (!enabled || !accessToken) return undefined
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load, enabled, accessToken])

  // 설비 목록은 이름표(통계 축·이벤트 필터)로만 쓴다 — 자주 바뀌지 않아 한 번만 받는다.
  useEffect(() => {
    if (!enabled || !accessToken) { setEquipments([]); return }
    let ok = true
    listEquipments(accessToken)
      .then((rows) => { if (ok && alive.current) setEquipments(rows || []) })
      // 이름표가 없어도 화면은 ID 로 돌아간다 — 여기서 오류를 띄우지 않는다
      .catch(() => { if (ok && alive.current) setEquipments([]) })
    return () => { ok = false }
  }, [enabled, accessToken])

  const robots = useMemo(() => stats?.robotStatus ?? [], [stats])

  // 서버 목록에서 사라진 로봇을 고른 채로 두면 빈 조회가 계속 나간다 — 제어 대상으로 되돌린다.
  useEffect(() => {
    if (!robots.length) return
    if (!robots.some((r) => r.robotId === selected)) setSelected(robotId)
  }, [robots, selected, robotId])

  const robotName = useCallback((id: string | null | undefined) => {
    if (!id) return '—'
    return robots.find((r) => r.robotId === id)?.name || id
  }, [robots])

  const equipmentName = useCallback((id: string | null | undefined) => {
    if (!id) return '—'
    return equipments.find((e) => eqId(e) === id)?.name || id
  }, [equipments])

  const value = useMemo<FleetContextValue>(() => ({
    stats,
    robots,
    selected,
    setSelected,
    multi: robots.length > 1,
    robotName,
    equipments,
    equipmentName,
    error,
    reload: load,
  }), [stats, robots, selected, robotName, equipments, equipmentName, error, load])

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>
}
