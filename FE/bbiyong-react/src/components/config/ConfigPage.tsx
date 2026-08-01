import { errMessage } from '../../live/errors.ts'
import { useEffect, useState } from 'react'
import { useSettings, DEFAULT_SETTINGS } from '../../settings/SettingsContext.tsx'
import { ROBOT_V_MAX, ROBOT_W_MAX } from '../../live/config.ts'
import { speedParams } from '../../live/mappers.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { putDriveSpeed, speedProblems } from '../../live/driveSpeed.ts'
import EquipmentPanel from './EquipmentPanel.tsx'

// 설정 (S15P11E101-475) — 가끔 바꾸는 값. 관리자만 들어온다.
// 주행 속도 상한은 서버에 저장되고 로봇에 하달된다(S15P11E101-515).
export default function ConfigPage() {
  const { settings, update, reset, driveSynced } = useSettings()
  const { enabled } = useLive()
  const { accessToken } = useAuth()
  const [draft, setDraft] = useState('')
  const [savingSpeed, setSavingSpeed] = useState(false)
  const [speedMsg, setSpeedMsg] = useState<{ kind: string, text: string } | null>(null)

  const spd = speedParams(settings.vMax)

  // 입력 중인 문자열은 따로 들고 있는다(S15P11E101-515).
  // 곧바로 settings 에 밀어 넣으면 0 이나 빈 칸을 거쳐 갈 때 속도 게이지와 주행 발행이
  // 그 값을 그대로 받는다. 그래서 화면에는 사용자가 친 그대로 두고, 양수일 때만 반영한다.
  const [vDraft, setVDraft] = useState<string | null>(null)
  const [wDraft, setWDraft] = useState<string | null>(null)
  const vShown = vDraft ?? String(settings.vMax)
  const wShown = wDraft ?? String(settings.wMax)
  // 서버 값을 받아 오면 입력칸도 그 값으로 되돌린다
  useEffect(() => { setVDraft(null); setWDraft(null) }, [driveSynced])

  const onSpeedInput = (which: any) => (e: any) => {
    const raw = e.target.value
    if (which === 'v') setVDraft(raw); else setWDraft(raw)
    const n = Number(raw)
    if (n > 0) update(which === 'v' ? { vMax: n } : { wMax: n })
  }

  // 서버가 양수만 받는다(@Positive) — 보내기 전에 걸러 400 을 왕복하지 않는다
  const speedErrs = speedProblems(Number(vShown), Number(wShown))

  const onSaveSpeed = async () => {
    if (savingSpeed || speedErrs.length) return
    setSavingSpeed(true)
    try {
      const r = await putDriveSpeed(
        { maxLinear: Number(vShown), maxAngular: Number(wShown) }, accessToken,
      )
      // 서버가 정규화한 값을 다시 받아 화면에 맞춘다
      if (Number(r?.maxLinear) > 0 && Number(r?.maxAngular) > 0) {
        update({ vMax: Number(r.maxLinear), wMax: Number(r.maxAngular) })
        setVDraft(null); setWDraft(null)
      }
      // 로봇이 꺼져 있어도 저장은 된다 — delivered 로 갈라 알린다(성공으로 뭉뚱그리면 오해한다)
      setSpeedMsg(r?.delivered
        ? { kind: 'ok', text: `상한을 저장하고 로봇에 하달했습니다 — 선속 ${r.maxLinear} m/s · 각속 ${r.maxAngular} rad/s` }
        : { kind: 'warn', text: '서버에는 저장됐지만 로봇에 전달되지 않았습니다 — 로봇이 연결되면 다시 저장하세요.' })
    } catch (e) {
      setSpeedMsg({ kind: 'err', text: `저장하지 못했습니다 — ${errMessage(e)}` })
    } finally { setSavingSpeed(false) }
  }

  const setPoint = (id: any, patch: any) => update({
    points: settings.points.map((p: any) => (p.id === id ? { ...p, ...patch } : p)),
  })
  const removePoint = (id: any) => update({ points: settings.points.filter((p: any) => p.id !== id) })
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
            로봇이 낼 수 있는 최대 속도입니다. 저장하면 서버에 기록되고 로봇에도 하달됩니다
            (<b className="mono">SET_MAX_SPEED</b>). 관제 화면의 속도 게이지 범위도 이 값을 따릅니다.
          </p>
          <div className="form-row">
            <label htmlFor="cfg-vmax">선속도 상한 (m/s)</label>
            <input
              id="cfg-vmax" type="number" step="0.05" min="0.05" max="3"
              value={vShown} onChange={onSpeedInput('v')}
            />
          </div>
          <div className="form-row">
            <label htmlFor="cfg-wmax">각속도 상한 (rad/s)</label>
            <input
              id="cfg-wmax" type="number" step="0.05" min="0.05" max="3"
              value={wShown} onChange={onSpeedInput('w')}
            />
          </div>
          {speedErrs.length > 0 && <div className="form-msg err">{speedErrs.join(' ')}</div>}
          {speedMsg && <div className={`form-msg ${speedMsg.kind}`} id="speedMsg">{speedMsg.text}</div>}
          <div className="gotor">
            <button
              type="button" id="btnSaveSpeed" className="dbtn go"
              onClick={onSaveSpeed}
              disabled={!enabled || savingSpeed || speedErrs.length > 0}
            >
              {savingSpeed ? '저장 중…' : '서버에 저장'}
            </button>
          </div>
          <div className="cfg-note">
            <div>슬라이더 범위 <b className="mono">{spd.min} ~ {spd.max} m/s</b> · 증감 <b className="mono">{spd.step}</b></div>
            <div>각속도는 상한 <b className="mono">{settings.wMax} rad/s</b>에 선속도와 같은 비율로 적용됩니다.</div>
            {enabled
              ? <div>{driveSynced ? '서버 저장값을 불러왔습니다.' : '아직 서버 값을 받지 못해 로컬 기본값을 씁니다.'}</div>
              : <div>시뮬레이션 모드에서는 이 브라우저에만 저장됩니다. 기본값 <b className="mono">{ROBOT_V_MAX} / {ROBOT_W_MAX}</b></div>}
          </div>
        </div>

        <div className="panel">
          <h3>열화상 임계 온도 <span className="k">THERMAL</span></h3>
          <p className="cfg-help">열화상 <b>화면의 색 표시</b> 기준입니다. 로봇의 과열 판정 기준은 <b>설비별 과열 임계 온도</b> 설정에서 분전반마다 따로 정합니다.</p>
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

        <EquipmentPanel />

        <div className="panel cfg-points">
          <h3>순찰 지점 <span className="k">WAYPOINTS</span></h3>
          <p className="cfg-help">
            관제 화면의 <b>지점 이동</b> 목록입니다. 좌표는 로봇 map 프레임 기준 미터입니다.
          </p>
          <ul className="pt-list">
            {settings.points.map((p: any) => (
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
