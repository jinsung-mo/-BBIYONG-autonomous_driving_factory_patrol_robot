import { useSim } from '../../SimContext.ts'
import { displayName } from '../../live/robotName.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { useZones } from '../../live/ZoneContext.tsx'
import { telemetryToStatus, isMapFrame } from '../../live/mappers.ts'
import RadialGauge from './RadialGauge.tsx'

// 순찰 로봇 상태 + 환경 + 이벤트 로그
// live 모드에서는 /topic/robots 텔레메트리를 그대로 표시한다.
// 주변 온도·습도는 로봇에 센서가 없어 텔레메트리에 없다(가이드 §3.1) → live 모드에서 숨긴다.
export default function StatusPanel() {
  const { status } = useSim()
  const { enabled, connected, telemetry, robotId } = useLive()
  const { labelOf } = useZones()

  const live = enabled ? telemetryToStatus(telemetry) : null
  // 연결이 끊겼을 때만 '연결 대기'로 말한다. 연결돼 있는데 status 만 없는 경우는 매퍼의 '대기'를 쓴다.
  const modeText = live ? (connected ? live.modeText : '연결 대기') : status.modeText
  const modeClass = live ? live.modeClass : status.modeClass
  const batt = live ? live.batt : status.batt
  const estop = live ? live.estop : status.estop
  const comm = live ? live.comm : '양호 · 43ms'
  // 화면에는 표시명을 쓴다(S15P11E101-766). 통신·구독은 계약 id 그대로다.
  const name = enabled ? displayName(robotId) : '삐용'

  // 상태를 색만으로 구분하지 않는다 — 색각 이상에서도 읽히도록 기호와 문구를 함께 준다.
  // 시뮬레이션 지표 카드용 — 화재·과열로 기록된 줄만 센다(정상 복귀 로그는 경보가 아니다)
  const estopReleased = estop === 'RELEASED'
  const estopUnknown = estop === '—'
  const commOk = !live || connected

  return (
    <div className="panel" id="pStatus">
      <h3>순찰 로봇 상태 <span className="k">ORINCA FLEET</span></h3>
      <div className="stat-card">
        <div className="rid">{name} <span className={`pillm ${modeClass}`}>{modeText}</span></div>
        {/* 시뮬레이션 화면에서는 배터리를 대표 지표로 세운다 — 막대보다 멀리서 읽힌다.
            실서버 화면은 기존 표기를 그대로 둔다. */}
        {enabled ? (
          <>
            <div className="kv"><span>배터리</span><b className="num">{batt == null ? '—' : `${batt} %`}</b></div>
            <div className="bar"><i style={{ width: `${batt ?? 0}%` }} /></div>
          </>
        ) : (
          <RadialGauge value={batt} label="배터리" caption="BATTERY" />
        )}
        <div className="kv">
          <span>통신 감도</span>
          <b className={`st ${commOk ? 'ok' : 'warn'}`}>{commOk ? '✓' : '▲'} {comm}</b>
        </div>
        {live?.location && (
          // 좌표는 조작자에게 뜻이 없다 — 구역·랜드마크 이름으로 말한다(S15P11E101-770).
          // 원좌표는 툴팁으로만 남긴다. 정합을 의심할 때 확인할 곳은 있어야 한다.
          <div className="kv">
            <span>위치</span>
            {/* map 프레임이 아니면 자리를 말하지 않는다(S15P11E101-773).
                odom 폴백 좌표를 구역 이름으로 옮기면 있지도 않은 구역을 말하게 된다. */}
            {isMapFrame(live.location)
              ? (
                <b
                  className="zone-label"
                  title={`${live.location.x?.toFixed(2)}, ${live.location.y?.toFixed(2)} m`}
                >
                  {labelOf(live.location.x, live.location.y)}
                </b>
              )
              : <b className="st warn loc-wait-badge">▲ 위치 확인 중</b>}
          </div>
        )}
      </div>
    </div>
  )
}
