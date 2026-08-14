import { createContext, useContext } from 'react'
import type useSimulation from './hooks/useSimulation.ts'

/**
 * useSimulation() 이 반환하는 번들을 트리 전역에 공급.
 *
 * 번들 형태를 손으로 다시 적지 않는다 — 훅의 반환 타입을 그대로 끌어다 쓰면
 * 훅이 바뀔 때 여기도 자동으로 따라온다.
 */
export type SimBundle = ReturnType<typeof useSimulation>

export const SimContext = createContext<SimBundle | null>(null)

/**
 * Provider 밖에서 부르면 던지므로 반환 타입을 non-null 로 좁힌다
 * (useAuth·useSettings 와 같은 규칙 — S15P11E101-570).
 */
export function useSim(): SimBundle {
  const ctx = useContext(SimContext)
  if (!ctx) throw new Error('useSim must be used within <SimContext.Provider>')
  return ctx
}
