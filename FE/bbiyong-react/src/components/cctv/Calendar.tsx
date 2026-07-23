// 달력 (7월 2026, 16일 today). 당월 일자를 클릭하면 onSelect(day) 호출.
interface CalCell {
  d: number
  today?: boolean
  dim?: boolean
}

const WEEKS: CalCell[][] = [
  [{ d: 28, dim: true }, { d: 29, dim: true }, { d: 30, dim: true }, { d: 1 }, { d: 2 }, { d: 3 }, { d: 4 }],
  [{ d: 5 }, { d: 6 }, { d: 7 }, { d: 8 }, { d: 9 }, { d: 10 }, { d: 11 }],
  [{ d: 12 }, { d: 13 }, { d: 14 }, { d: 15 }, { d: 16, today: true }, { d: 17 }, { d: 18 }],
  [{ d: 19 }, { d: 20 }, { d: 21 }, { d: 22 }, { d: 23 }, { d: 24 }, { d: 25 }],
  [{ d: 26 }, { d: 27 }, { d: 28 }, { d: 29 }, { d: 30 }, { d: 31 }, { d: 1, dim: true }],
]

interface CalendarProps {
  selected: number | null
  onSelect: (day: number) => void
}

export default function Calendar({ selected, onSelect }: CalendarProps) {
  return (
    <table className="cal">
      <caption>7월 2026</caption>
      <tbody>
        <tr>{['일', '월', '화', '수', '목', '금', '토'].map((w) => <th key={w}>{w}</th>)}</tr>
        {WEEKS.map((week, i) => (
          <tr key={i}>
            {week.map((cell, j) => {
              const cls = [
                cell.today ? 'today' : '',
                cell.dim ? 'dim' : '',
                !cell.dim && cell.d === selected ? 'picked' : '',
                !cell.dim ? 'clk' : '',
              ].filter(Boolean).join(' ')
              return (
                <td
                  key={j}
                  className={cls || undefined}
                  onClick={cell.dim ? undefined : () => onSelect(cell.d)}
                >
                  {cell.d}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
