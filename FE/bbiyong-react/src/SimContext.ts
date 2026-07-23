import { createContext, useContext } from 'react'
import type { SimBundle } from './types'

// useSimulation() 이 반환하는 번들을 트리 전역에 공급
export const SimContext = createContext<SimBundle | null>(null)

export function useSim(): SimBundle {
  const ctx = useContext(SimContext)
  if (!ctx) throw new Error('useSim must be used within <SimContext.Provider>')
  return ctx
}
