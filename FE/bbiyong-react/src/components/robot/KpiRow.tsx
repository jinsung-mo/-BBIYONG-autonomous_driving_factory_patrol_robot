import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { telemetryToStatus } from '../../live/mappers.ts'

// 화면 맨 위의 큰 숫자들.
//
// 굵기가 아니라 크기로 위계를 만든다 — 숫자는 굵게 쓰지 않는다.
// 값이 없으면 '—' 로 둔다. 없는 수치를 그리면 조작자가 그것을 믿는다.
//
// 배지는 색만으로 알리지 않는다. 정상·주의·위험을 기호와 함께 준다 —
// 색각 이상에서도 읽혀야 한다.
type Tone = 'ok' | 'warn' | 'bad' | 'none'

const SIGN: Record<Tone, string> = { ok: '✓', warn: '!', bad: '⚠', none: '–' }

function Kpi({ value, unit, label, tone = 'none', note }: {
  value: string, unit?: string, label: string, tone?: Tone, note?: string,
}) {
  return (
    <div className="kpi">
      <div>
        <div className="kpi-num">
          {value}{unit && <span className="unit">{unit}</span>}
        </div>
        <div className="kpi-label">{label}</div>
      </div>
      <span className={`kpi-badge ${tone}`} aria-hidden="true">{SIGN[tone]}</span>
      {note && <span className="sr-only">{note}</span>}
    </div>
  )
}

export default function KpiRow() {
  const { status } = useSim()
  const { enabled, connected, telemetry, alerts } = useLive()

  const live = enabled ? telemetryToStatus(telemetry) : null
  const batt = live ? live.batt : status.batt

  const battTone: Tone = batt == null ? 'none' : batt <= 15 ? 'bad' : batt <= 35 ? 'warn' : 'ok'

  // 최고 온도 — 'MAX 38.4°C ⚠ 임계 초과' 같은 표시 문자열에서 숫자만 뽑는다.
  // 실서버에 해당 텔레메트리가 없으면 임의 값을 만들지 않고 '—' 로 둔다.
  const hot = enabled ? Number.NaN
    : Number(String(status.thermalMax || '').match(/-?\d+(\.\d+)?/)?.[0])
  const alarmCount = enabled ? alerts.length
    : (status.logs || []).filter((log: any) => log.kind === 'fire' || log.kind === 'heat').length

  const robotOnline = enabled ? (connected && telemetry?.status !== 'OFFLINE') : true
  const robotTone: Tone = robotOnline ? 'ok' : 'bad'

  return (
    <div className="kpis">
      <Kpi
        value={batt == null ? '—' : String(batt)} unit={batt == null ? undefined : '%'}
        label="배터리" tone={battTone}
      />
      <Kpi
        value={Number.isFinite(hot) ? hot.toFixed(1) : '—'} unit={Number.isFinite(hot) ? '°C' : undefined}
        label="최고 온도" tone={!Number.isFinite(hot) ? 'none' : hot >= 60 ? 'bad' : hot >= 45 ? 'warn' : 'ok'}
      />
      <Kpi
        value={String(alarmCount)} unit="건"
        label="경보 이벤트" tone={alarmCount > 0 ? 'bad' : 'none'}
      />
      <Kpi
        value={robotOnline ? 'ON' : 'OFF'}
        label="로봇 상태" tone={robotTone}
      />
    </div>
  )
}
