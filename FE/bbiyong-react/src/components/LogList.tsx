import { useSim } from '../SimContext'
import type { LogVariant } from '../types'

// 경보/이벤트 로그 (CCTV의 .alist, 로봇의 .elog에서 공용).
// 항목 클릭 시 로봇 탭으로 전환 (원본 동작).
export default function LogList({ variant = 'alist' }: { variant?: LogVariant }) {
  const { status, setTab } = useSim()
  return (
    <ul className={variant}>
      {status.logs.map((log) => (
        <li key={log.id} className={log.kind} onClick={() => setTab('robot')}>
          <span className="t mono">{log.time}</span>
          <b>{log.msg}</b>
        </li>
      ))}
    </ul>
  )
}
