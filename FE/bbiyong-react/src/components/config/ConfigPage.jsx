import { useState } from 'react'
import { useSettings, DEFAULT_SETTINGS } from '../../settings/SettingsContext.jsx'
import { ROBOT_V_MAX, ROBOT_W_MAX } from '../../live/config.js'
import { speedParams } from '../../live/mappers.js'

// 설정 (S15P11E101-475) — 가끔 바꾸는 값. 관리자만 들어온다.
export default function ConfigPage() {
  const { settings, update, reset } = useSettings()
  const [draft, setDraft] = useState('')

  const spd = speedParams(settings.vMax)

  const setPoint = (id, patch) => update({
    points: settings.points.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  })
  const removePoint = (id) => update({ points: settings.points.filter((p) => p.id !== id) })
  const addPoint = () => {
    const label = draft.trim()
    if (!label) return
    update({ points: [...settings.points, { id: `p${Date.now()}`, label, x: 0, y: 0 }] })
    setDraft('')
  }

  return (
    <section id="pgConfig" className="page on section-page">
      <div className="cfg-grid">
        <div className="panel">
          <h3>주행 속도 상한 <span className="k">DRIVE LIMIT</span></h3>
          <p className="cfg-help">
            관제 화면의 속도 게이지 범위를 정합니다. 로봇 teleop 상한(<b className="mono">V_MAX</b>)과 같은 값이어야
            슬라이더 숫자와 실제 속도가 일치합니다(S15P11E101-463).
          </p>
          <div className="form-row">
            <label htmlFor="cfg-vmax">선속도 상한 (m/s)</label>
            <input
              id="cfg-vmax" type="number" step="0.05" min="0.05" max="3"
              value={settings.vMax}
              onChange={(e) => update({ vMax: Math.max(0.05, Number(e.target.value) || 0.05) })}
            />
          </div>
          <div className="cfg-note">
            <div>슬라이더 범위 <b className="mono">{spd.min} ~ {spd.max} m/s</b> · 증감 <b className="mono">{spd.step}</b></div>
            <div>각속도는 로봇 상한 <b className="mono">{ROBOT_W_MAX} rad/s</b>에 같은 비율로 적용됩니다.</div>
            <div>환경변수 기본값 <b className="mono">{ROBOT_V_MAX}</b></div>
          </div>
        </div>

        <div className="panel">
          <h3>열화상 임계 온도 <span className="k">THERMAL</span></h3>
          <p className="cfg-help">열화상 화면의 경고·임계 표시 기준입니다.</p>
          <div className="form-row">
            <label htmlFor="cfg-warn">주의 (℃)</label>
            <input id="cfg-warn" type="number" step="1" value={settings.tempWarn}
              onChange={(e) => update({ tempWarn: Number(e.target.value) || 0 })} />
          </div>
          <div className="form-row">
            <label htmlFor="cfg-crit">임계 (℃)</label>
            <input id="cfg-crit" type="number" step="1" value={settings.tempCritical}
              onChange={(e) => update({ tempCritical: Number(e.target.value) || 0 })} />
          </div>
          {settings.tempWarn >= settings.tempCritical && (
            <div className="form-msg err">주의 온도는 임계 온도보다 낮아야 합니다.</div>
          )}
        </div>

        <div className="panel cfg-points">
          <h3>순찰 지점 <span className="k">WAYPOINTS</span></h3>
          <p className="cfg-help">
            관제 화면의 <b>지점 이동</b> 목록입니다. 좌표는 로봇 map 프레임 기준 미터입니다.
          </p>
          <ul className="pt-list">
            {settings.points.map((p) => (
              <li key={p.id}>
                <input aria-label="지점 이름" value={p.label} onChange={(e) => setPoint(p.id, { label: e.target.value })} />
                <input aria-label="x (m)" type="number" step="0.1" value={p.x}
                  onChange={(e) => setPoint(p.id, { x: Number(e.target.value) || 0 })} />
                <input aria-label="y (m)" type="number" step="0.1" value={p.y}
                  onChange={(e) => setPoint(p.id, { y: Number(e.target.value) || 0 })} />
                <button type="button" className="dbtn stop" onClick={() => removePoint(p.id)}
                  disabled={settings.points.length <= 1}>삭제</button>
              </li>
            ))}
          </ul>
          <div className="gotor">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="새 지점 이름 (예: 분전반 D)" />
            <button type="button" className="dbtn go" onClick={addPoint} disabled={!draft.trim()}>추가</button>
          </div>
          {settings.points.length <= 1 && (
            <div className="cfg-note">지점은 최소 1개가 있어야 관제 화면의 지점 이동이 동작합니다.</div>
          )}
        </div>

        <div className="panel">
          <h3>초기화 <span className="k">RESET</span></h3>
          <p className="cfg-help">모든 설정을 기본값으로 되돌립니다. 되돌린 값은 즉시 관제 화면에 반영됩니다.</p>
          <button type="button" className="dbtn stop" onClick={reset}>기본값으로 되돌리기</button>
          <div className="cfg-note">
            기본값 — 속도 상한 {DEFAULT_SETTINGS.vMax} m/s · 주의 {DEFAULT_SETTINGS.tempWarn}℃ · 임계 {DEFAULT_SETTINGS.tempCritical}℃ · 지점 {DEFAULT_SETTINGS.points.length}개
          </div>
        </div>
      </div>
    </section>
  )
}
