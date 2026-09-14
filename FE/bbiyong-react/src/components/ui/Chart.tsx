// 작은 SVG 차트 — 꺾은선(시계열)과 누적 막대(집계) 두 가지.
//
// 차트 라이브러리를 넣지 않은 이유: 이 앱의 런타임 의존성은 react 와 stompjs 뿐이고,
// 여기서 필요한 것은 축 두 개짜리 꺾은선과 2단 누적 막대가 전부다. chart.js 계열은
// gzip 60kB 안팎이라 현재 번들(91kB)을 크게 흔든다.
//
// viewBox 로 그리고 width 는 100% 라 패널 크기를 따라간다. 값 확인은 <title>(브라우저 툴팁).

const PAD = { top: 10, right: 42, bottom: 20, left: 40 }

type Series = {
  key: string
  label: string
  color: string
  /** null 은 결측 — 선을 잇지 않고 끊는다 */
  values: Array<number | null>
  /** 단위가 다른 값을 겹쳐 볼 때 오른쪽 축을 쓴다 */
  axis?: 'left' | 'right'
  /** 축 눈금에 붙일 단위 */
  unit?: string
}

// 데이터가 한 점뿐이거나 전부 같은 값이면 0 나누기가 난다.
function bounds(values: Array<number | null>) {
  const ns = values.filter((v): v is number => typeof v === 'number')
  if (!ns.length) return { lo: 0, hi: 1 }
  let lo = Math.min(...ns)
  let hi = Math.max(...ns)
  if (lo === hi) { lo = lo - 1; hi = hi + 1 }
  // 위아래로 조금 띄워야 선이 테두리에 붙지 않는다
  const pad = (hi - lo) * 0.1
  // 다만 음수가 없는 값(건수·배터리·FPS)에 음수 눈금을 만들지는 않는다 — 없는 범위를 지어내는 셈이다
  const floor = Math.min(...ns) >= 0 ? 0 : -Infinity
  return { lo: Math.max(floor, lo - pad), hi: hi + pad }
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10)

/**
 * 시계열 꺾은선. 왼쪽/오른쪽 축을 따로 잡아 단위가 다른 값을 겹쳐 볼 수 있다.
 */
export function LineChart({
  labels, series, height = 180, emptyText = '데이터가 없습니다.',
}: {
  labels: string[]
  series: Series[]
  height?: number
  emptyText?: string
}) {
  const W = 640
  const H = height
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const n = labels.length

  if (!n || !series.length) return <div className="chart-empty">{emptyText}</div>

  const left = series.filter((s) => (s.axis || 'left') === 'left')
  const right = series.filter((s) => s.axis === 'right')
  const lb = bounds(left.flatMap((s) => s.values))
  const rb = bounds(right.flatMap((s) => s.values))

  // 점이 하나면 가운데에 찍는다 (n-1 로 나누면 0 나누기)
  const x = (i: number) => PAD.left + (n === 1 ? iw / 2 : (i * iw) / (n - 1))
  const y = (v: number, axis: 'left' | 'right') => {
    const b = axis === 'right' ? rb : lb
    return PAD.top + ih - ((v - b.lo) / (b.hi - b.lo)) * ih
  }

  // null 을 만나면 path 를 끊는다 — 통신이 끊겼던 구간을 이어 그리면 없던 데이터를 지어내는 셈이다
  const pathOf = (s: Series) => {
    const axis = s.axis || 'left'
    let d = ''
    let pen = false
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v, axis).toFixed(1)} `
      pen = true
    })
    return d.trim()
  }

  // x 축 라벨은 5개 안팎만 — 다 그리면 겹친다
  const stride = Math.max(1, Math.ceil(n / 5))
  const ticks = [0, 0.5, 1]

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={series.map((s) => s.label).join(', ')} preserveAspectRatio="xMidYMid meet">
        {/* 가로 눈금 */}
        {ticks.map((t) => {
          const yy = PAD.top + ih - t * ih
          return (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} y1={yy} x2={W - PAD.right} y2={yy} />
              <text className="chart-tick" x={PAD.left - 6} y={yy + 3} textAnchor="end">
                {fmt(lb.lo + t * (lb.hi - lb.lo))}
              </text>
              {right.length > 0 && (
                <text className="chart-tick" x={W - PAD.right + 6} y={yy + 3}>
                  {fmt(rb.lo + t * (rb.hi - rb.lo))}
                </text>
              )}
            </g>
          )
        })}

        {series.map((s) => (
          <path key={s.key} className="chart-line" d={pathOf(s)} stroke={s.color} fill="none" />
        ))}

        {/* 값 확인용 — 마지막 점만 찍는다(전 구간에 원을 찍으면 24시간치가 뭉갠다) */}
        {series.map((s) => {
          const li = [...s.values].reverse().findIndex((v) => v != null)
          if (li === -1) return null
          const i = s.values.length - 1 - li
          const v = s.values[i] as number
          return (
            <circle key={`${s.key}-dot`} cx={x(i)} cy={y(v, s.axis || 'left')} r="3" fill={s.color}>
              <title>{`${s.label} ${fmt(v)}${s.unit || ''} (${labels[i]})`}</title>
            </circle>
          )
        })}

        {labels.map((l, i) => (i % stride === 0 || i === n - 1) && (
          <text key={`${l}-${i}`} className="chart-tick" x={x(i)} y={H - 6} textAnchor="middle">{l}</text>
        ))}
      </svg>
      <ul className="chart-legend">
        {series.map((s) => (
          <li key={s.key}><i style={{ background: s.color }} />{s.label}{s.unit ? ` (${s.unit})` : ''}</li>
        ))}
      </ul>
    </div>
  )
}

type Bar = { label: string, parts: Array<{ key: string, value: number, color: string, name: string }> }

/**
 * 2단 누적 막대. 이벤트 통계(긴급/경고)를 한 막대에 쌓아 총량과 구성비를 같이 본다.
 */
export function BarChart({
  bars, height = 180, emptyText = '데이터가 없습니다.',
}: {
  bars: Bar[]
  height?: number
  emptyText?: string
}) {
  const W = 640
  const H = height
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const n = bars.length

  if (!n) return <div className="chart-empty">{emptyText}</div>

  const totals = bars.map((b) => b.parts.reduce((s, p) => s + (p.value || 0), 0))
  // 전부 0이면 축 최대값을 1로 둔다 — 0으로 나누지 않으려는 것이고, 막대는 안 보이는 게 맞다
  const hi = Math.max(1, ...totals)
  const slot = iw / n
  const bw = Math.max(4, Math.min(34, slot * 0.6))
  const stride = Math.max(1, Math.ceil(n / 8))
  const legend = bars[0]?.parts ?? []

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label="이벤트 통계" preserveAspectRatio="xMidYMid meet">
        {[0, 0.5, 1].map((t) => {
          const yy = PAD.top + ih - t * ih
          return (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} y1={yy} x2={W - PAD.right} y2={yy} />
              <text className="chart-tick" x={PAD.left - 6} y={yy + 3} textAnchor="end">{Math.round(t * hi)}</text>
            </g>
          )
        })}

        {bars.map((b, i) => {
          const cx = PAD.left + slot * i + slot / 2
          let acc = 0
          return (
            <g key={`${b.label}-${i}`}>
              {b.parts.map((p) => {
                const h = ((p.value || 0) / hi) * ih
                const yy = PAD.top + ih - acc - h
                acc += h
                if (h <= 0) return null
                return (
                  <rect key={p.key} x={cx - bw / 2} y={yy} width={bw} height={h} fill={p.color} rx="2">
                    <title>{`${b.label} · ${p.name} ${p.value}건`}</title>
                  </rect>
                )
              })}
              {(i % stride === 0 || i === n - 1) && (
                <text className="chart-tick" x={cx} y={H - 6} textAnchor="middle">{b.label}</text>
              )}
            </g>
          )
        })}
      </svg>
      <ul className="chart-legend">
        {legend.map((p) => (
          <li key={p.key}><i style={{ background: p.color }} />{p.name}</li>
        ))}
      </ul>
    </div>
  )
}
