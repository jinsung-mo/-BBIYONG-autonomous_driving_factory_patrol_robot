// @ts-check
import { createContext, useContext } from 'react'

// useSimulation() 이 반환하는 번들을 트리 전역에 공급
export const SimContext = createContext(null)

export function useSim() {
  const ctx = useContext(SimContext)
  if (!ctx) throw new Error('useSim must be used within <SimContext.Provider>')
  return ctx
}
