import { useId } from 'react'

// 시뮬레이션 화면의 대표 지표용 원형 게이지.
//
// 관제 화면에서 가장 먼저 읽혀야 하는 값(배터리)을 숫자 한 줄이 아니라 형태로 보여준다.
// 멀리서는 호의 길이와 색으로, 가까이서는 가운데 숫자로 읽힌다.
//
// 차트 라이브러리를 쓰지 않는다 — 이 값 하나 때문에 번들을 늘릴 이유가 없다.
// 눈금은 270°(0.75바퀴)만 돌린다. 한 바퀴를 다 채우면 시작점과 끝점이 붙어
// "가득 참"과 "비어 있음"이 같은 모양으로 보인다.

const R = 52
const C = 2 * Math.PI * R
const SWEEP = 0.75          // 270°
const START = -225          // 왼쪽 아래에서 시작해 오른쪽 아래로 끝난다

export default function RadialGauge({ value, unit = '%', label, caption, tone }: {
  value: number | null
  unit?: string
  label: string
  caption?: string
  /** 색을 직접 정할 때. 없으면 값으로 판단한다(배터리 기준). */
  tone?: 'ok' | 'warn' | 'danger'
}) {
  const gradientId = useId().replace(/:/g, '')
  const known = typeof value === 'number' && Number.isFinite(value)
  const v = known ? Math.max(0, Math.min(100, value)) : 0
  const level = tone || (!known ? 'ok' : v <= 15 ? 'danger' : v <= 35 ? 'warn' : 'ok')
  const filled = C * SWEEP * (v / 100)

  return (
    <div className={`rgauge ${level}`}>
      <svg viewBox="0 0 128 128" role="img" aria-label={`${label} ${known ? `${v}${unit}` : '알 수 없음'}`}>
        {/* 눈금 색은 한 가지가 아니라 같은 계열 안에서 옮겨 간다 — 시작과 끝이 구분돼
            호가 어느 방향으로 자라는지 읽힌다. 의미(정상·주의·위험)는 계열이 지킨다. */}
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" className="rg-a" />
            <stop offset="100%" className="rg-b" />
          </linearGradient>
        </defs>
        <circle className="rgauge-track" cx="64" cy="64" r={R}
          strokeDasharray={`${C * SWEEP} ${C}`} transform={`rotate(${START} 64 64)`} />
        <circle className="rgauge-fill" cx="64" cy="64" r={R} stroke={`url(#${gradientId})`}
          strokeDasharray={`${filled} ${C}`} transform={`rotate(${START} 64 64)`} />
      </svg>
      <div className="rgauge-mid">
        <b>{known ? v : '—'}<i>{known ? unit : ''}</i></b>
        <span>{label}</span>
      </div>
      {caption && <div className="rgauge-cap">{caption}</div>}
    </div>
  )
}
