import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { ROBOT_V_MAX } from '../live/config.js'

// 운영 설정 (S15P11E101-475 설정 탭).
//
// 관제 화면에 상시 노출돼 있던 값들을 여기로 모은다 — 가끔 바꾸는 값이 늘 보이면
// 화면이 복잡해지고, 실수로 건드릴 여지도 커진다.
//
// 지금은 localStorage 에 둔다. 서버에 설정 API 가 생기면 이 컨텍스트의 저장 경로만
// 바꾸면 되고, 화면 코드는 그대로다.

const KEY = 'bbiyong.settings'

// 순찰 지점은 미터(map 프레임) 좌표로 둔다.
// 시뮬은 격자를 쓰지만 worldToCell 로 환산하면 되고, 실서버 NAVIGATE 는 미터가 정답이라
// 저장값을 미터로 두는 편이 나중에 어긋나지 않는다.
export const DEFAULT_SETTINGS = {
  vMax: ROBOT_V_MAX,      // 주행 속도 상한 (m/s) — S15P11E101-463
  tempWarn: 52,           // 열화상 주의 (℃)
  tempCritical: 60,       // 열화상 임계 (℃)
  points: [
    { id: 'a', label: '분전반 A', x: 4, y: 0 },
    { id: 'b', label: '분전반 B', x: 11, y: 4 },
    { id: 'c', label: '분전반 C', x: 7, y: 7 },
  ],
}

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS
    // 저장본에 없는 키는 기본값으로 메운다 — 설정 항목이 늘어나도 예전 저장본이 깨지지 않는다
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      points: Array.isArray(saved.points) && saved.points.length ? saved.points : DEFAULT_SETTINGS.points,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const SettingsContext = createContext(null)

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(read)

  const update = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 저장 실패는 무시 */ }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    try { localStorage.removeItem(KEY) } catch { /* 무시 */ }
    setSettings(DEFAULT_SETTINGS)
  }, [])

  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset])
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
