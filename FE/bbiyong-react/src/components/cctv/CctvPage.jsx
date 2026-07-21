import { useState } from 'react'
import { useSim } from '../../SimContext.js'
import Calendar from './Calendar.jsx'
import PtzPanel from './PtzPanel.jsx'
import DateLogModal from './DateLogModal.jsx'
import LogList from '../LogList.jsx'

// 화재 감지 카드 (불꽃/연기 상세)
function DetectCard({ det, fireOn }) {
  return (
    <div className="card grow-card">
      <h3><span className="dot" />화재 감지</h3>
      <div className="detrow">
        <div className="det sel">
          <div className="cn">공장 CCTV</div>
          <table>
            <tbody>
              <tr>
                <td>불꽃</td>
                <td className={`v${fireOn ? ' fire' : ''}`}>{det.flameState}</td>
                <td className={`v mono${fireOn ? ' fire' : ''}`}>{det.flamePct}</td>
              </tr>
              <tr>
                <td>연기</td>
                <td className="v">{det.smokeState}</td>
                <td className="v mono">{det.smokePct}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// 화면 · CCTV 관제 (라이트/다크 테마 대응)
export default function CctvPage({ active }) {
  const { status, refs } = useSim()
  const { det, fireOn } = status
  const [sound, setSound] = useState(true)     // 경보음 토글 (표시 전용)
  const [pickedDay, setPickedDay] = useState(null) // 클릭한 달력 날짜

  return (
    <section id="pgA" className={`page${active ? ' on' : ''}`}>
      <div className="a-head">
        <h1>화재 감지</h1>
        <span className="chip">장치 <b>8</b></span>
        <span className="chip mono">2026. 07. 16</span>
        <div className="tgl">
          <button className={`tglbtn${sound ? ' on' : ''}`} onClick={() => setSound((v) => !v)}>
            {sound ? '🔔 경보음 ON' : '🔕 경보음 OFF'}
          </button>
        </div>
      </div>

      {/* 3열: 좌 사이드바 · 중앙(카메라+상세) · 우 사이드바 — 사이드바가 카메라 상단까지 올라옴 */}
      <div className="a-grid">
        {/* 좌: 장치 / 날짜 / 경보 알림 */}
        <div className="stack">
          <div className="card">
            <h3>🎥 장치</h3>
            <select><option>공장 CCTV</option></select>
          </div>
          <div className="card">
            <h3>🗓 날짜 <span style={{ fontWeight: 400, color: 'var(--sub)', fontSize: 11, marginLeft: 6 }}>— 일자 클릭 시 로그</span></h3>
            <Calendar selected={pickedDay} onSelect={setPickedDay} />
          </div>
          <div className="card grow-card">
            <h3>📋 경보 알림</h3>
            <LogList variant="alist" />
          </div>
        </div>

        {/* 중앙: 카메라(신뢰도 제거분만큼 확대) + 조작 패널 */}
        <div className="stack">
          <div className={`cam grow-cam${fireOn ? ' alert' : ''}`}>
            <canvas ref={refs.cam3} />
            <span className="st">{fireOn ? '⚠ 화재 감지' : '감시 중'}</span>
            <span className="tag">[공장 CCTV <em>화재감지</em>]</span>
          </div>
          <PtzPanel />
        </div>

        {/* 우: 신뢰도 (화재 감지 위) / 화재 감지 */}
        <div className="stack">
          <div className="card grow-card">
            <h3>
              📈 신뢰도
              <span style={{ fontWeight: 400, color: 'var(--sub)', fontSize: 11, marginLeft: 6 }}>— 불꽃 · 24시간</span>
            </h3>
            <div className="chart"><canvas ref={refs.conf} /></div>
          </div>
          <DetectCard det={det} fireOn={fireOn} />
        </div>
      </div>

      {pickedDay != null && (
        <DateLogModal day={pickedDay} liveLogs={status.logs} onClose={() => setPickedDay(null)} />
      )}
    </section>
  )
}
