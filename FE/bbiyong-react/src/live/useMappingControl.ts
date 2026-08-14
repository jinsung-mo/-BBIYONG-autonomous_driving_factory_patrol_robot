import { useEffect, useState } from 'react'
import { useLive } from './LiveContext.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { MAPPING_STATUS } from './mapping.ts'
import { replaceWaypoints } from './waypoints.ts'
import { resetInspection } from './inspection.ts'
import { ROBOT_ID } from './config.ts'
import { playVoice } from './voice.ts'

// 매핑(2D 맵 모델링) 제어 상태·핸들러 (S15P11E101-904).
//
// 예전에는 MappingTab 안에 있었는데, 맵 모델링 버튼을 서브탭 줄(지도/매핑) 오른쪽으로
// 옮기면서(사용자 지침 2026-08-10) 그 줄을 그리는 공유 머리(App.ConsoleHeader)가
// 같은 상태를 써야 해서 훅으로 뺐다. 버튼·확인 모달은 호출부가 그린다 — 여기는 로직만.
export interface MappingControl {
  /** idle | requested(시작 발행 후 대기) | running(매핑 중) | complete */
  phase: 'idle' | 'requested' | 'running' | 'complete'
  offline: boolean
  confirming: boolean
  setConfirming: (v: boolean) => void
  /** 확인 모달의 '시작' — 실제 START_MAPPING 발행 + 음성 안내 */
  onStart: () => void
  onStopMapping: () => void
  msg: { kind: string, text: string } | null
}

export function useMappingControl(): MappingControl {
  const { enabled, connected, control, telemetry, mapping, mappingComplete, clearMappingComplete } = useLive()
  const { accessToken } = useAuth()
  const [confirming, setConfirming] = useState(false)
  const [requested, setRequested] = useState(false)   // START_MAPPING 발행 후 로봇 반응 대기
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)

  // 진행 단계. 완료 이벤트 > 로봇이 보고하는 MAPPING > 발행 직후 대기 순으로 우선한다.
  const running = mapping || telemetry?.status === MAPPING_STATUS
  const phase: MappingControl['phase'] = mappingComplete ? 'complete' : (running ? 'running' : (requested ? 'requested' : 'idle'))

  // 로봇이 매핑에 들어갔거나 끝났으면 '대기 중' 딱지는 역할이 끝났다
  useEffect(() => { if (running || mappingComplete) setRequested(false) }, [running, mappingComplete])

  const onStart = () => {
    setConfirming(false)
    setMsg(null)
    clearMappingComplete()
    // 새 맵은 좌표계가 바뀌어 옛 맵 기준 순찰/점검 지점이 무의미해진다(S15P11E101-911) —
    // 매핑 시작 시 초기화한다. 순찰 지점은 빈 배열 PUT(replaceWaypoints)으로 서버에서 전량
    // 삭제, 점검 지점은 저장 없는 relay 라 로컬 스토어만 비운다.
    replaceWaypoints([], accessToken, ROBOT_ID).catch(() => { /* 실패해도 매핑 시작은 진행 */ })
    resetInspection()
    control.startMapping()
    setRequested(true)
    playVoice('mappingStart')   // "맵핑을 시작합니다"(01) — 버튼 클릭 제스처 직후라 재생 허용된다
  }

  const onStopMapping = () => {
    control.stopMapping()
    setRequested(false)
    // 중단은 '저장 없이 취소'다(로봇 mapping_orchestrator.stop 은 저장/업로드/완료 이벤트를
    // 내지 않는다 — be_robot 확인 2026-08-10). 그런데 직전에 도착·잔존한 완료 이벤트가 남아
    // 있으면 phase 가 'complete' 로 걸려 "저장된 것처럼" 보인다. 중단 시 그 딱지를 지운다.
    clearMappingComplete()
    setMsg({ kind: 'warn', text: '매핑 중단을 요청했습니다. 저장 없이 취소되며, 로봇이 멈추면 진행 표시가 사라집니다.' })
  }

  return { phase, offline: !enabled || !connected, confirming, setConfirming, onStart, onStopMapping, msg }
}
