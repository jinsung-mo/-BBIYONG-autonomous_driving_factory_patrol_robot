// AprilTag 점검 지점 (S15P11E101-787 / BE 계약 S15P11E101-778)
//
// 로봇이 벽에 붙은 AprilTag 를 보면 후보를 올린다. 태그가 붙은 자리(target)와
// 그것을 보기 위해 로봇이 서는 자리(viewpoint)가 한 쌍이다. auto_confirm 은 false 라
// 사람이 승인해야 순찰 목적지가 된다 — 로봇이 스스로 목적지를 늘리지 않는다.
//
// 좌표는 전부 미터·map 프레임이다. 순찰 지점(Waypoint.x/y)과 같은 좌표계라
// navMap.ts 의 변환을 그대로 쓴다.
//
// 이 파일이 유일한 공급처다. 로봇 cloud_bridge 배선 전까지는 목 데이터를 내주고,
// 배선이 끝나면 이 안쪽만 바꾼다 — 패널과 지도는 손대지 않는다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { subscribe, publish } from './stompClient.ts'
import type {
  InspectionCandidate, InspectionPoint, InspectionPointCommand,
} from './contracts.d.ts'

/** 수신 토픽. 후보·확정 점이 같은 토픽으로 오고 kind 로 갈린다. */
export const INSPECTION_TOPIC = '/topic/inspection'
/** 명령 발행지. */
export const INSPECTION_DEST = '/app/control/inspection'

/** 계약 버전. 서버와 다른 값이 오면 해석하지 않고 흘린다 — 잘못 읽느니 안 읽는다. */
export const SCHEMA_VERSION = 1

const isV1 = (m: any) => Number(m?.schemaVersion ?? SCHEMA_VERSION) === SCHEMA_VERSION

// ---- 목 데이터 -------------------------------------------------------------
//
// 로봇 배선 전까지 화면을 만들기 위한 값이다. 실서버에서 진짜 메시지가 한 번이라도
// 오면 목은 물러난다 — 목과 실물이 섞여 보이면 어느 쪽을 믿을지 알 수 없다.

const MOCK_CANDIDATES: InspectionCandidate[] = [
  {
    schemaVersion: 1, kind: 'inspection_candidate', candidateId: 'cand-101', tagId: 101,
    confidence: 0.94, target: { x: 3.20, y: 4.85 }, viewpoint: { x: 2.40, y: 4.85, yaw: 0 },
    standOffM: 0.8, source: 'apriltag', createdAt: '2026-08-06T20:14:03Z',
  },
  {
    schemaVersion: 1, kind: 'inspection_candidate', candidateId: 'cand-102', tagId: 102,
    confidence: 0.71, target: { x: 6.05, y: 2.10 }, viewpoint: { x: 6.05, y: 2.95, yaw: -1.5708 },
    standOffM: 0.85, source: 'apriltag', createdAt: '2026-08-06T20:15:47Z',
  },
  {
    schemaVersion: 1, kind: 'inspection_candidate', candidateId: 'cand-103', tagId: 103,
    confidence: 0.58, target: { x: 1.15, y: 7.40 }, viewpoint: { x: 1.95, y: 7.40, yaw: 3.1416 },
    standOffM: 0.8, source: 'apriltag', createdAt: '2026-08-06T20:17:22Z',
  },
]

/** 확정 점의 sequence 를 1..n 으로 다시 매긴다. 삭제 뒤 번호가 비면 순서를 못 읽는다. */
export function resequence(points: InspectionPoint[]): InspectionPoint[] {
  return [...points]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((p, i) => (p.sequence === i + 1 ? p : { ...p, sequence: i + 1 }))
}

/** 후보 → 확정 점. 승인 시점에 이름과 순서가 붙는다. */
function toPoint(c: InspectionCandidate, name: string, sequence: number): InspectionPoint {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'inspection_point',
    pointId: `pt-${c.candidateId}`,
    tagId: c.tagId,
    target: c.target,
    viewpoint: c.viewpoint,
    standOffM: c.standOffM,
    confidence: c.confidence,
    source: c.source,
    name: name || `태그 ${c.tagId}`,
    sequence,
    enabled: true,
  }
}

/**
 * 명령을 계약 스키마 그대로 만들어 보낸다.
 *
 * 여기서 모양을 만드는 이유는 하나다 — 로봇·저장·순찰이 같은 스키마를 나눠 쓰므로
 * 필드를 부르는 자리마다 조립하면 반드시 어긋난다.
 *
 * @returns 실제로 발행됐으면 true. 연결이 없으면 false 이고, 그때도 화면은 진행한다
 *          (목 개발 중에는 보낼 곳이 없다).
 */
export function sendPointCommand(cmd: InspectionPointCommand): boolean {
  const body: InspectionPointCommand = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'inspection_point_command',
    command: cmd.command,
  }
  // 있는 것만 싣는다. 빈 필드를 채워 보내면 서버가 '지우라는 뜻' 으로 읽을 수 있다.
  if (cmd.candidateId) body.candidateId = cmd.candidateId
  if (cmd.pointId) body.pointId = cmd.pointId
  if (cmd.name != null) body.name = cmd.name
  if (cmd.sequence != null) body.sequence = cmd.sequence
  if (cmd.enabled != null) body.enabled = cmd.enabled
  return publish(INSPECTION_DEST, body as any)
}

// ---- 구독 ------------------------------------------------------------------

/**
 * 후보와 확정 점을 함께 받는다. 두 목록이 한 토픽으로 오고, 승인하면 한쪽에서
 * 다른 쪽으로 옮겨 가므로 따로 구독하면 두 목록이 잠깐 어긋난다.
 */
export function useInspection() {
  const [candidates, setCandidates] = useState<InspectionCandidate[]>(MOCK_CANDIDATES)
  const [points, setPoints] = useState<InspectionPoint[]>([])
  // 실물이 한 번이라도 오면 목을 걷는다
  const liveRef = useRef(false)

  useEffect(() => subscribe(INSPECTION_TOPIC, (raw: any) => {
    if (!isV1(raw)) return
    const kind = String(raw?.kind || '')
    if (kind !== 'inspection_candidate' && kind !== 'inspection_point'
      && kind !== 'inspection_snapshot') return
    if (!liveRef.current) {
      liveRef.current = true
      setCandidates([])
      setPoints([])
    }
    if (kind === 'inspection_snapshot') {
      // 서버가 목록 전체를 줄 때. 부분 갱신보다 이쪽이 정확하다.
      setCandidates((Array.isArray(raw.candidates) ? raw.candidates : []).filter(isV1))
      setPoints(resequence((Array.isArray(raw.points) ? raw.points : []).filter(isV1)))
      return
    }
    if (kind === 'inspection_candidate') {
      setCandidates((prev) => {
        const i = prev.findIndex((c) => c.candidateId === raw.candidateId)
        if (i < 0) return [...prev, raw]
        const next = [...prev]; next[i] = raw; return next
      })
      return
    }
    setPoints((prev) => {
      const i = prev.findIndex((p) => p.pointId === raw.pointId)
      const next = i < 0 ? [...prev, raw] : prev.map((p, k) => (k === i ? raw : p))
      return resequence(next)
    })
  }), [])

  // 승인 — 후보를 목록에서 빼고 확정 목록 끝에 붙인다.
  // 서버가 실물을 내려 주면 그 값으로 덮이지만, 그 왕복을 기다리는 동안 화면이
  // 아무 반응도 없으면 조작자는 한 번 더 누른다.
  const confirm = useCallback((candidateId: string, name: string) => {
    sendPointCommand({ command: 'CONFIRM', candidateId, name } as InspectionPointCommand)
    setCandidates((prev) => {
      const c = prev.find((x) => x.candidateId === candidateId)
      if (c) setPoints((ps) => resequence([...ps, toPoint(c, name, ps.length + 1)]))
      return prev.filter((x) => x.candidateId !== candidateId)
    })
  }, [])

  const reject = useCallback((candidateId: string) => {
    sendPointCommand({ command: 'REJECT', candidateId } as InspectionPointCommand)
    setCandidates((prev) => prev.filter((x) => x.candidateId !== candidateId))
  }, [])

  const rename = useCallback((pointId: string, name: string) => {
    sendPointCommand({ command: 'UPDATE', pointId, name } as InspectionPointCommand)
    setPoints((prev) => prev.map((p) => (p.pointId === pointId ? { ...p, name } : p)))
  }, [])

  const setEnabled = useCallback((pointId: string, enabled: boolean) => {
    sendPointCommand({ command: 'UPDATE', pointId, enabled } as InspectionPointCommand)
    setPoints((prev) => prev.map((p) => (p.pointId === pointId ? { ...p, enabled } : p)))
  }, [])

  const remove = useCallback((pointId: string) => {
    sendPointCommand({ command: 'DELETE', pointId } as InspectionPointCommand)
    // 지운 뒤 번호를 다시 매긴다 — 2번이 빠진 채 1,3,4 로 남으면 순서를 못 읽는다
    setPoints((prev) => resequence(prev.filter((p) => p.pointId !== pointId)))
  }, [])

  /** 확정 목록을 로봇에 내려보낸다. 승인만으로는 순찰이 바뀌지 않는다. */
  const publishAll = useCallback(() => sendPointCommand({ command: 'PUBLISH' } as InspectionPointCommand), [])

  return useMemo(() => ({
    candidates, points, confirm, reject, rename, setEnabled, remove, publishAll,
  }), [candidates, points, confirm, reject, rename, setEnabled, remove, publishAll])
}
