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

import { useEffect, useMemo, useSyncExternalStore } from 'react'
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

// ---- 공유 스토어 -------------------------------------------------------------
//
// 이 훅은 운영 탭 패널·운영 지도·지도 탭 3D 가 각자 부른다. 훅 인스턴스마다 상태를
// 두면 승인이 그 화면에만 반영되고 다른 화면은 로봇 회신까지 어긋난다 — 상태를 모듈
// 하나로 모아 모든 화면이 같은 값을 본다.

type InspectionState = { candidates: InspectionCandidate[], points: InspectionPoint[] }

// 로봇이 AprilTag 를 보고 후보를 올리기 전까지 승인 대기 목록은 비어 있다.
// (예전에는 화면을 만들기 위한 목 후보 3건을 초기값으로 넣어, 로봇 배선 전에는
//  '항상 3건' 이 떠 있었다 — 실운영에서 유령 후보로 보여 걷어냈다.)
let state: InspectionState = { candidates: [], points: [] }
// 실물(후보/확정/스냅샷)이 한 번이라도 오면 목을 걷는다
let live = false
const storeListeners = new Set<() => void>()

const getState = () => state
function setState(mut: (prev: InspectionState) => InspectionState) {
  const next = mut(state)
  if (next === state) return
  state = next
  storeListeners.forEach((fn) => fn())
}
const subscribeStore = (fn: () => void) => {
  storeListeners.add(fn)
  return () => { storeListeners.delete(fn) }
}

// 점검 지점 로컬 스토어를 비운다(S15P11E101-911). 새 매핑을 시작하면 좌표계가 바뀌어
// 옛 맵 기준 점검 지점은 무의미하므로 초기화한다. 서버는 저장하지 않는 relay 라 REST 삭제가
// 아니라 이 로컬 스토어만 비우면 된다 — 로봇이 새 스냅샷을 보내면 그때 다시 채워진다.
export function resetInspection() {
  setState((s) => (s.candidates.length || s.points.length ? { candidates: [], points: [] } : s))
}

/**
 * 명령을 로컬 상태에 적용한다. 두 경로가 같은 함수를 쓴다:
 *   1) 내가 보낸 명령의 낙관적 반영 — 왕복을 기다리는 동안 화면이 조용하면 한 번 더 누른다
 *   2) 서버 echo(다른 접속자·탭의 명령) — 서버는 점검 지점을 저장하지 않는 relay 라,
 *      echo 를 각자 재현해야 로봇 회신 없이도 모든 화면이 같은 목록을 본다
 * 같은 명령이 두 번 와도(1 뒤에 2) 전이가 멱등이라 안전하다.
 */
function applyCommand(cmd: InspectionPointCommand) {
  const command = String(cmd?.command || '').toUpperCase()
  if (command === 'CONFIRM') {
    setState((s) => {
      const c = s.candidates.find((x) => x.candidateId === cmd.candidateId)
      if (!c) return s   // 이미 옮겼거나(멱등) 모르는 후보 — 로봇 스냅샷이 최종 진실
      return {
        candidates: s.candidates.filter((x) => x.candidateId !== cmd.candidateId),
        points: resequence([...s.points, toPoint(c, String(cmd.name || ''), s.points.length + 1)]),
      }
    })
    return
  }
  if (command === 'REJECT') {
    setState((s) => (s.candidates.some((x) => x.candidateId === cmd.candidateId)
      ? { ...s, candidates: s.candidates.filter((x) => x.candidateId !== cmd.candidateId) }
      : s))
    return
  }
  if (command === 'UPDATE') {
    setState((s) => ({
      ...s,
      points: s.points.map((p) => (p.pointId === cmd.pointId
        ? {
            ...p,
            ...(cmd.name != null ? { name: cmd.name } : {}),
            ...(cmd.enabled != null ? { enabled: cmd.enabled } : {}),
          }
        : p)),
    }))
    return
  }
  if (command === 'DELETE') {
    // 지운 뒤 번호를 다시 매긴다 — 2번이 빠진 채 1,3,4 로 남으면 순서를 못 읽는다
    setState((s) => ({ ...s, points: resequence(s.points.filter((p) => p.pointId !== cmd.pointId)) }))
  }
  // PUBLISH 는 화면 상태를 바꾸지 않는다
}

function onMessage(raw: any) {
  if (!isV1(raw)) return
  const kind = String(raw?.kind || '')
  if (kind === 'inspection_point_command') {
    // 서버 echo. 목은 걷지 않는다 — 로봇 배선 전 데모에서도 다른 탭의 목 후보가
    // 같은 전이를 밟아야 화면끼리 어긋나지 않는다.
    applyCommand(raw as InspectionPointCommand)
    return
  }
  if (kind !== 'inspection_candidate' && kind !== 'inspection_point'
    && kind !== 'inspection_snapshot') return
  if (!live) {
    live = true
    setState(() => ({ candidates: [], points: [] }))
  }
  if (kind === 'inspection_snapshot') {
    // 서버가 목록 전체를 줄 때. 부분 갱신보다 이쪽이 정확하다.
    setState(() => ({
      candidates: (Array.isArray(raw.candidates) ? raw.candidates : []).filter(isV1),
      points: resequence((Array.isArray(raw.points) ? raw.points : []).filter(isV1)),
    }))
    return
  }
  if (kind === 'inspection_candidate') {
    setState((s) => {
      const i = s.candidates.findIndex((c) => c.candidateId === raw.candidateId)
      if (i < 0) return { ...s, candidates: [...s.candidates, raw] }
      const next = [...s.candidates]; next[i] = raw
      return { ...s, candidates: next }
    })
    return
  }
  setState((s) => {
    const i = s.points.findIndex((p) => p.pointId === raw.pointId)
    const next = i < 0 ? [...s.points, raw] : s.points.map((p, k) => (k === i ? raw : p))
    return { ...s, points: resequence(next) }
  })
}

// STOMP 구독은 훅 사용자가 하나라도 있을 때만 유지한다. 영구 구독으로 두면
// 로그아웃(disconnect)이 stompClient 레지스트리를 비운 뒤 재로그인해도 안 살아난다.
let mounted = 0
let unsubTopic: (() => void) | null = null
function retainTopic() {
  if (mounted++ === 0) unsubTopic = subscribe(INSPECTION_TOPIC, onMessage)
  return () => {
    if (--mounted === 0 && unsubTopic) { unsubTopic(); unsubTopic = null }
  }
}

// ---- 조작 -------------------------------------------------------------------
// 모듈 함수라 항상 같은 참조다 — 훅 반환 객체의 메모이즈가 흔들리지 않는다.

function command(cmd: InspectionPointCommand) {
  sendPointCommand(cmd)
  applyCommand(cmd)
}

/** 승인 — 후보를 목록에서 빼고 확정 목록 끝에 붙인다. */
const confirm = (candidateId: string, name: string) =>
  command({ command: 'CONFIRM', candidateId, name } as InspectionPointCommand)
const reject = (candidateId: string) =>
  command({ command: 'REJECT', candidateId } as InspectionPointCommand)
const rename = (pointId: string, name: string) =>
  command({ command: 'UPDATE', pointId, name } as InspectionPointCommand)
const setEnabled = (pointId: string, enabled: boolean) =>
  command({ command: 'UPDATE', pointId, enabled } as InspectionPointCommand)
const remove = (pointId: string) =>
  command({ command: 'DELETE', pointId } as InspectionPointCommand)
/** 확정 목록을 로봇에 내려보낸다. 승인만으로는 순찰이 바뀌지 않는다. */
const publishAll = () => { sendPointCommand({ command: 'PUBLISH' } as InspectionPointCommand) }

/**
 * 후보와 확정 점을 함께 받는다. 두 목록이 한 토픽으로 오고, 승인하면 한쪽에서
 * 다른 쪽으로 옮겨 가므로 따로 구독하면 두 목록이 잠깐 어긋난다.
 */
export function useInspection() {
  useEffect(retainTopic, [])
  const snap = useSyncExternalStore(subscribeStore, getState)
  return useMemo(() => ({
    candidates: snap.candidates,
    points: snap.points,
    confirm, reject, rename, setEnabled, remove, publishAll,
  }), [snap])
}
