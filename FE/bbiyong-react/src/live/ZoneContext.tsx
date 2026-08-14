import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext.tsx'
import { useLive } from './LiveContext.tsx'
import { useSettings } from '../settings/SettingsContext.tsx'
import { fetchZones, locationLabel, movedEnough } from './zones.ts'
import { listEquipments } from './equipments.ts'
import type { Zone, ZoneLandmark } from './contracts.d.ts'

// 구역 목록과 랜드마크를 한 번만 받아 화면들이 나눠 쓴다(S15P11E101-770).
//
// 라벨은 로봇이 움직일 때마다 필요하지만, 목록은 관리자가 고칠 때만 바뀐다.
// 화면마다 따로 받으면 같은 목록을 여러 번 긁는다.

interface ZoneCtx {
  zones: Zone[]
  landmarks: ZoneLandmark[]
  reload: () => Promise<void>
  /** 좌표 → 화면 문구. 0.5m 안쪽 이동은 이전 값을 그대로 쓴다. */
  labelOf: (x: number | null | undefined, y: number | null | undefined) => string
}

const Ctx = createContext<ZoneCtx>({
  zones: [], landmarks: [], reload: async () => {}, labelOf: () => '—',
})

export function ZoneProvider({ children }: { children: any }) {
  const { accessToken } = useAuth()
  const { enabled } = useLive()
  const { settings } = useSettings()
  const [zones, setZones] = useState<Zone[]>([])
  const [equip, setEquip] = useState<any[]>([])

  const reload = useCallback(async () => {
    if (!enabled || !accessToken) { setZones([]); return }
    try { setZones(await fetchZones(accessToken)) } catch { /* 구역이 없어도 화면은 돌아간다 */ }
    try { setEquip(await listEquipments(accessToken)) } catch { setEquip([]) }
  }, [enabled, accessToken])

  useEffect(() => { reload() }, [reload])

  // 설비와 순찰 지점을 한 묶음으로 본다 — 조작자에게는 둘 다 '아는 자리' 다.
  const landmarks = useMemo<ZoneLandmark[]>(() => [
    ...equip.filter((e: any) => Number.isFinite(Number(e?.x)) && Number.isFinite(Number(e?.y)))
      .map((e: any) => ({ type: 'EQUIPMENT' as const, id: e.equipmentId ?? e.id, name: e.name || e.equipmentId, x: Number(e.x), y: Number(e.y) })),
    ...(settings?.points || []).filter((p: any) => Number.isFinite(Number(p?.x)))
      .map((p: any) => ({ type: 'WAYPOINT' as const, id: p.id, name: p.label || p.id, x: Number(p.x), y: Number(p.y) })),
  ], [equip, settings?.points])

  // 마지막으로 계산한 자리와 그때의 문구. 0.5m 안쪽이면 다시 만들지 않는다.
  const cache = useRef<{ at: { x: number, y: number }, text: string } | null>(null)
  // 목록이 바뀌면(관리자가 이름을 고치면) 캐시는 버린다 — 즉시 반영돼야 한다.
  useEffect(() => { cache.current = null }, [zones, landmarks])

  const labelOf = useCallback((x: number | null | undefined, y: number | null | undefined) => {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return '—'
    const px = Number(x)
    const py = Number(y)
    if (cache.current && !movedEnough(cache.current.at, px, py)) return cache.current.text
    const text = locationLabel(zones, landmarks, px, py)
    cache.current = { at: { x: px, y: py }, text }
    return text
  }, [zones, landmarks])

  const value = useMemo(() => ({ zones, landmarks, reload, labelOf }), [zones, landmarks, reload, labelOf])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useZones = () => useContext(Ctx)
