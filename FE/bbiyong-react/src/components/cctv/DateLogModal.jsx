import Modal from '../ui/Modal.jsx'
import { historyLogs, TODAY } from '../../data/history.js'

// 선택한 날짜의 로그 기록. 오늘은 라이브 로그, 과거는 결정적 목 로그.
export default function DateLogModal({ day, liveLogs, onClose }) {
  const logs = day === TODAY ? liveLogs : historyLogs(day)
  return (
    <Modal title={`2026. 07. ${String(day).padStart(2, '0')} — 로그 기록`} onClose={onClose} width={460}>
      {logs.length === 0 ? (
        <div className="empty-log">해당 날짜의 기록이 없습니다.</div>
      ) : (
        <ul className="alist modal-log">
          {logs.map((log) => (
            <li key={log.id} className={log.kind}>
              <span className="t mono">{log.time}</span>
              <b>{log.msg}</b>
            </li>
          ))}
        </ul>
      )}
      {day === TODAY && <div className="auth-hint" style={{ textAlign: 'left', marginTop: 8 }}>오늘 — 실시간 로그</div>}
    </Modal>
  )
}
