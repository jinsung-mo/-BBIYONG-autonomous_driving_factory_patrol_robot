import { useSim } from '../SimContext.js'
import { useLive } from '../live/LiveContext.jsx'
import { alertToLog } from '../live/mappers.js'

// 이벤트 로그 (순찰 로봇 관제의 .elog).
//
// live 모드에서는 /topic/alerts 수신 내역을 최신순으로 보여준다.
// (서버에 로그 스트리밍 토픽이 없다 — 과거 이력은 REST `GET /api/events` 소관이라 별도 작업.)
export default function LogList({ variant = 'elog' }) {
  const { status } = useSim()
  const { enabled, connected, alerts } = useLive()

  const logs = enabled ? alerts.map(alertToLog).reverse() : status.logs

  if (enabled && logs.length === 0) {
    return (
      <ul className={variant}>
        <li className="ok"><b>{connected ? '경보 없음 — 수신 대기 중' : '실서버 연결 중…'}</b></li>
      </ul>
    )
  }

  return (
    <ul className={variant}>
      {logs.map((log) => (
        <li key={log.id} className={log.kind}>
          <span className="t mono">{log.time}</span>
          <b>{log.msg}</b>
        </li>
      ))}
    </ul>
  )
}
