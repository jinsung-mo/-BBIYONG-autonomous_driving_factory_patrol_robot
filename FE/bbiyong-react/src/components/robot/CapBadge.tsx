import { useLive } from '../../live/LiveContext.tsx'
import { capOf, capLabel, CAP_UNKNOWN } from '../../live/capabilities.ts'

// 패널 헤더 우측의 서브시스템 상태 배지 (초록 정상 / 주황 지연 / 회색 중단)
//
// live 모드에서만 뜬다. 시뮬에는 로봇 서브시스템이 없어 판정할 것이 없고,
// 로봇이 capabilities 를 보고하지 않으면(unknown) 아무것도 표시하지 않는다 —
// 모르는 것을 '중단'으로 단정하면 멀쩡한 패널을 죽은 것처럼 보이게 한다.
/** @param {{ capKey: string }} props CAP_KEYS 의 값 하나 */
export default function CapBadge({ capKey }: { capKey: string }) {
  const { enabled, telemetry } = useLive()
  if (!enabled) return null

  const state = capOf(telemetry, capKey)
  if (state === CAP_UNKNOWN) return null

  // 색만으로 구분하지 않는다 — 상태마다 기호를 달리해 색각 이상에서도 읽히게 한다
  const MARK: Record<string, string> = { online: '●', stale: '▲', offline: '■' }
  const mark = MARK[state]

  return (
    <span className={`capb ${state}`} title={`로봇 서브시스템 ${capLabel(state)}`}>
      <i aria-hidden="true">{mark}</i>{capLabel(state)}
    </span>
  )
}
