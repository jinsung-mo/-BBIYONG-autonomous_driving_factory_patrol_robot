import { useEffect, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'

// Orin 전력 모드 — 저성능/고성능 토글 + 실시간 부하 그래프(S15P11E101-814).
//
// 데이터 출처: Orin 의 `tegrastats` 한 줄(CPU 코어별 %, GR3D_FREQ, VDD_IN mW).
// 🔴 로봇/서버가 아직 이 값을 보내지 않는다 — telemetry.orinPower 는 지금 항상 undefined 다.
// 값이 없으면 반드시 '—' 로 표시하고 그래프는 그리지 않는다 — 없는 수치를 그리면 조작자가
// 그것을 믿는다(KpiRow.tsx 와 같은 원칙). 필드가 생기면 아래 옵셔널 체이닝이 그대로
// 값을 읽어 자동으로 그린다. 기대 필드명 정의는 contracts.d.ts 의 OrinPowerTelemetry 참고.

type Tone = 'ok' | 'warn' | 'danger'

// 🔴 CPU·GPU 임계치는 아직 잠정이다 — orin-load-v6.html 의 예시값을 그대로 가져왔다.
// 실제 임계치는 Orin 열설계·듀티 한계(docs/실측_데이터.md §E, /tmp/orincar_power.json)를
// 보고 팀이 따로 정해야 한다.
const CORE_WARN = 70, CORE_DANGER = 90
const GPU_WARN = 50, GPU_DANGER = 80

// ── 전력 축 [사용자 확인 2026-08-08] ────────────────────────────────────────
// 🔴 **peak 25 W** 다. 잠정치(15,000mW)를 실제 스펙으로 교체한다.
// 절대 스케일을 쓰는 이유가 여기 있다 — 축이 고정돼야 "지금 얼마나 쓰고 있나" 가 읽힌다.
//
// 참고로 실측 idle 은 VDD_IN 9,089 mW ≈ 9.1 W (2026-08-08 tegrastats).
// peak 25 W 대비 **약 36%** 다. 즉 대기 상태에서 정격의 1/3 만 쓰고 있고,
// 그만큼 여유가 있다는 뜻이라 저성능 모드로 내릴 근거가 된다 — 이 패널의 존재 이유다.
const PWR_AXIS_MAX = 25000
// 경고선은 축의 70% / 88% 로 잡는다(17.5 W / 22 W). peak 근처에서만 빨강이 뜨게 해,
// 평상시 주황이 상시 켜져 경고가 무뎌지는 것을 막는다.
const PWR_WARN = 17500, PWR_DANGER = 22000

function statusOf(v: number, warn: number, danger: number): Tone {
  return v >= danger ? 'danger' : v >= warn ? 'warn' : 'ok'
}

const HIST_LEN = 20

/** 실제로 관측된 값만 쌓는다 — 값이 없으면(undefined/NaN) 이력을 늘리지 않는다.
 *  관측이 3개면 막대도 3개다. 있지도 않은 과거를 그리지 않는다.
 *  (KpiRow 에도 같은 원칙의 useTrend 가 있었지만 2026-08-09 에 스파크라인과 함께 제거됐다 —
 *   여기 부하 그래프는 '추세를 보는 것' 자체가 목적이라 그대로 둔다.) */
function useNumHistory(value: number | null, n = HIST_LEN) {
  const [hist, setHist] = useState<number[]>([])
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return
    setHist((h) => (h[h.length - 1] === value ? h : [...h, value].slice(-n)))
  }, [value, n])
  return hist
}

/** 값 기준 절대 스케일(0~axisMax) 막대 그래프. 막대마다 자기 값 기준으로 색이 정해진다
 *  (전체가 최근 3개만 상태색이던 시안 원본과 다르게, 이 화면은 전부 값 기준으로 칠한다). */
function LoadSpark({ hist, warn, danger, axisMax = 100 }: {
  hist: number[], warn: number, danger: number, axisMax?: number,
}) {
  if (hist.length < 2) return <div className="opw-spark" aria-hidden="true" />
  const trackH = 44
  return (
    <div className="opw-spark" aria-hidden="true">
      {hist.map((v, i) => {
        const h = Math.max(2, Math.min(trackH, (v / axisMax) * trackH))
        const tone = statusOf(v, warn, danger)
        return <i key={i} className={`st-${tone}`} style={{ height: `${h.toFixed(1)}px` }} />
      })}
    </div>
  )
}

function LoadCard({ title, value, unit, sub, hist, warn, danger, axisMax }: {
  title: string, value: number | null, unit: string, sub: string,
  hist: number[], warn: number, danger: number, axisMax?: number,
}) {
  const tone = value == null ? null : statusOf(value, warn, danger)
  return (
    <div className="opw-card">
      <div className="opw-card__t">{title}</div>
      <div className="opw-card__v">
        <b className={tone ? `st-${tone}` : undefined}>{value == null ? '—' : value.toFixed(0)}</b>
        <span className="unit">{unit}</span>
      </div>
      <div className="opw-card__sub">{sub}</div>
      <LoadSpark hist={hist} warn={warn} danger={danger} axisMax={axisMax} />
    </div>
  )
}

export default function OrinPowerPanel() {
  const { telemetry } = useLive()
  const power = telemetry?.orinPower

  const cores = power?.cpuCores
  // 🔴 CPU 는 "코어 평균"이 아니라 "코어 최댓값"을 그린다. 6코어 평균은 코어별 노이즈가
  // 상쇄돼 60~64% 사이에서만 흔들려 막대 높이 차이가 눈에 안 보인다(실측 사례: 코어 1개만
  // 77%, 나머지 42~47% 인데 평균은 62.6% 로 뭉개진다). 최댓값은 그 편중을 그대로 드러내고
  // 실제로 잘 움직인다. 축은 절대(0~100%) 그대로 유지한다 — 상대(min-max) 스케일로 바꾸면
  // 1%p 변동이 전체 높이로 증폭돼 거짓 인상을 준다.
  const cpuMax = cores && cores.length ? Math.max(...cores) : null
  const cpuAvg = cores && cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : null
  const gpu = power?.gpuPercent ?? null
  const vddIn = power?.vddInMw ?? null

  const cpuHist = useNumHistory(cpuMax)
  const gpuHist = useNumHistory(gpu)
  const pwrHist = useNumHistory(vddIn)

  return (
    <div className="card-v3 cfg-wide" id="pgOrinPower">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>Orin 전력 모드 <span className="k">POWER</span></h3>
      <p className="cfg-help">
        부하가 낮으면 고성능 모드로 돌릴 이유가 없고, 저성능으로 내리면 운영 시간이 늘어납니다.
        아래 그래프는 그 판단의 근거이므로 토글과 한 화면에 둡니다.
      </p>

      {/* 저성능/고성능 토글 — 지도 탭 세그먼트(#pgMap .map-tabs)와 같은 알약 문법.
          🔴 로봇 연동이 아직 없다 — 눌러도 실제로 아무 일도 일어나지 않는데 눌리기만 하면
          조작자를 속이는 셈이라 disabled + 안내문으로 명확히 알린다(순찰 종료 버튼,
          RoutePanel.tsx S15P11E101-868 과 같은 패턴). 현재 모드도 로봇이 보고하지 않으므로
          두 세그먼트 중 하나를 "선택됨"으로 지어내지 않는다. */}
      <div
        className="opw-tabs" role="group" aria-label="Orin 전력 모드"
        title="로봇 연동 대기 — 아직 전력 모드 명령을 보내지 않습니다"
      >
        <button type="button" disabled>저성능</button>
        <button type="button" disabled>고성능</button>
      </div>
      <p className="cfg-help" style={{ marginTop: 6, marginBottom: 0 }}>
        <b>전력 모드</b>는 로봇 연동 대기 중입니다 — 지금은 눌러도 실제로 바뀌지 않습니다.
      </p>

      <div className="opw-row">
        <LoadCard
          title="CPU 부하"
          value={cpuMax} unit="%"
          sub={`코어 최댓값 기준 · 평균 ${cpuAvg == null ? '—' : cpuAvg.toFixed(0)}%`}
          hist={cpuHist} warn={CORE_WARN} danger={CORE_DANGER}
        />
        <LoadCard
          title="GPU 부하"
          value={gpu} unit="%"
          sub="GR3D_FREQ"
          hist={gpuHist} warn={GPU_WARN} danger={GPU_DANGER}
        />
        <LoadCard
          title="전력 소비 (VDD_IN)"
          value={vddIn} unit="mW"
          sub="모듈 전체 입력"
          hist={pwrHist} warn={PWR_WARN} danger={PWR_DANGER} axisMax={PWR_AXIS_MAX}
        />
      </div>
    </div>
  )
}
