import { useLive } from '../../live/LiveContext.tsx'
import { useFleet } from '../../live/FleetContext.tsx'

// 편성 로봇 현황 — dashboard.stats 의 robotStatus (S15P11E101-591)
//
// 여태 관제 화면은 ROBOT_ID 한 대만 보여줬다. 요약 띠에 "전체 2대"라고 쓰면서
// 나머지 한 대는 어디에도 없는 상태였다 — 이 목록이 그 자리를 메운다.
//
// 고르는 것은 **조회 대상**이다. 주행·E-STOP 같은 제어는 STOMP 토픽이 로봇마다 갈리고
// 이 화면의 조작 패널은 ROBOT_ID 에 붙어 있어 그대로 나간다. 이 구분이 흐려지면
// 다른 로봇을 보면서 이 로봇을 조작하는 사고가 나므로 화면에도 적어 둔다.

const STATUS_TEXT: Record<string, string> = {
  AUTO_PATROL: '순찰 중',
  APPROACH: '접근 중',
  VERIFY: '근접 확인',
  MANUAL_CONTROL: '수동 조작',
  MAPPING: '맵핑 중',
  CHARGING: '충전 중',
  IDLE: '대기',
  OFFLINE: 'OFF',
}

const num = (v: number | null | undefined, unit: string, digits = 0) =>
  (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—')

export default function FleetList() {
  const { enabled, robotId } = useLive()
  const { robots, selected, setSelected, multi } = useFleet()

  // 시뮬레이션 모드에는 편성 정보가 없다. 1대뿐이면 기존 화면과 달라질 것이 없으므로 내지 않는다.
  if (!enabled || !multi) return null

  return (
    <div className="fleet sim-skin" id="pFleet">
      <h3 className="fleet-h">
        편성 로봇 <span className="k">{robots.length}대</span>
      </h3>
      <ul className="fleet-list">
        {robots.map((r) => {
          const on = r.online !== false
          const isSel = r.robotId === selected
          const isCtl = r.robotId === robotId
          return (
            <li key={r.robotId} className={`${isSel ? 'sel' : ''}${on ? '' : ' off'}`}>
              <button type="button" className="fleet-btn"
                aria-pressed={isSel}
                aria-label={`${r.name || r.robotId} 조회 대상으로 선택`}
                onClick={() => setSelected(r.robotId)}>
                <span className="fleet-nm">
                  {r.name || r.robotId}
                  {/* 제어가 나가는 로봇을 표시한다 — 고른 로봇과 다를 수 있다 */}
                  {isCtl && <i className="tag ctrl">제어</i>}
                  {isSel && <i className="tag sel">조회</i>}
                </span>
                <span className="fleet-st">
                  {on ? (STATUS_TEXT[r.status || ''] || r.status || '대기') : 'OFF'}
                </span>
                <span className="fleet-kv mono">
                  {num(r.battery, '%')} · {num(r.commLatencyMs, 'ms')} · {num(r.inferenceFps, 'fps', 1)}
                </span>
                {/* 끊긴 로봇의 값은 마지막으로 받은 것이다 — 지금 값처럼 보이면 안 된다 */}
                {!on && <span className="fleet-warn">연결 끊김 — 아래 값은 마지막으로 받은 것입니다</span>}
                {/* 실제 값은 RELEASED | ENGAGED 다(RobotPacket · cloud_bridge.py).
                    가이드 문서 예시의 'NONE' 은 실제로 오지 않으므로, 해제가 아닌 값을 모두 체결로 본다. */}
                {r.estop && r.estop !== 'RELEASED' && (
                  <span className="fleet-warn">⚠ E-STOP 체결 ({r.estop})</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {selected !== robotId && (
        <div className="fleet-note">
          조회 대상은 <b>{robots.find((r) => r.robotId === selected)?.name || selected}</b>,
          조작 패널이 명령을 보내는 로봇은 <b>{robots.find((r) => r.robotId === robotId)?.name || robotId}</b>입니다.
        </div>
      )}
    </div>
  )
}
