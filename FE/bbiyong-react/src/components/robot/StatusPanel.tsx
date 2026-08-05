import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { telemetryToStatus } from '../../live/mappers.ts'
import LogList from '../LogList.tsx'
import FleetList from '../dashboard/FleetList.tsx'
import RadialGauge from './RadialGauge.tsx'

// 순찰 로봇 상태 + 환경 + 이벤트 로그
// live 모드에서는 /topic/robots 텔레메트리를 그대로 표시한다.
// 주변 온도·습도는 로봇에 센서가 없어 텔레메트리에 없다(가이드 §3.1) → live 모드에서 숨긴다.
export default function StatusPanel() {
  const { status } = useSim()
  const { enabled, connected, telemetry, robotId } = useLive()

  const live = enabled ? telemetryToStatus(telemetry) : null
  // 연결이 끊겼을 때만 '연결 대기'로 말한다. 연결돼 있는데 status 만 없는 경우는 매퍼의 '대기'를 쓴다.
  const modeText = live ? (connected ? live.modeText : '연결 대기') : status.modeText
  const modeClass = live ? live.modeClass : status.modeClass
  const batt = live ? live.batt : status.batt
  const estop = live ? live.estop : status.estop
  const comm = live ? live.comm : '양호 · 43ms'
  const name = enabled ? robotId : '삐용'

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
          <span>E-STOP</span>
          {/* 체결은 즉시 눈에 띄어야 한다 — 강한 빨강 + 깜빡임 + 경고 기호 */}
          <b className={estopUnknown ? '' : (estopReleased ? 'st ok' : 'st danger')}>
            {estopUnknown ? '—' : (estopReleased ? '✓ 해제' : `⚠ 체결 (${estop})`)}
          </b>
        </div>
        <div className="kv">
          <span>통신 감도</span>
          <b className={`st ${commOk ? 'ok' : 'warn'}`}>{commOk ? '✓' : '▲'} {comm}</b>
        </div>
        {live?.location && (
          // 미터 단위 원시 좌표 — 지도 격자 변환과 무관하게 서버 값 그대로 확인할 수 있도록 노출
          <div className="kv"><span>위치</span><b className="num">
            {live.location.x?.toFixed(2)}, {live.location.y?.toFixed(2)} m
          </b></div>
        )}
      </div>
      {/* 편성이 2대 이상이면 나머지 로봇도 여기서 본다(S15P11E101-591) */}
      <FleetList />
      <h3 className="event-title">이벤트 로그</h3>
      <LogList variant="elog" />
    </div>
  )
}
