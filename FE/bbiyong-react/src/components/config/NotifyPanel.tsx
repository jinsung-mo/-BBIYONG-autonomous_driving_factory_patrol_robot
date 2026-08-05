import { useCallback, useEffect, useRef, useState } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { errMessage } from '../../live/errors.ts'
import {
  fetchNotificationSetting, saveNotificationSetting,
  SEVERITY_HELP, webhookProblem,
} from '../../live/notifications.ts'

type Level = import('../../live/contracts.d.ts').EventLevel

// Mattermost 알림 설정 (설정 탭) — GET/PUT /api/notifications/settings
//
// 공장이 비는 20시~08시에는 관제 화면을 보는 사람이 없다. 화면 안의 팝업 경보만으로는
// 아무도 모르고 지나간다 — 이 설정이 화면 밖으로 알리는 유일한 통로다.
export default function NotifyPanel() {
  const { enabled } = useLive()
  const { accessToken, isAdmin, canOperate } = useAuth()

  const [on, setOn] = useState(false)
  const [url, setUrl] = useState('')
  const [severity, setSeverity] = useState<Level>('WARNING')

  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    if (!enabled || !accessToken) return
    try {
      const s = await fetchNotificationSetting(accessToken)
      if (!alive.current) return
      setOn(!!s?.mattermostEnabled)
      setUrl(s?.mattermostWebhookUrl || '')
      setSeverity(s?.minSeverity === 'CRITICAL' ? 'CRITICAL' : 'WARNING')
      setLoaded(true)
    } catch (e) {
      // 설정이 한 번도 저장된 적 없으면 404 가 날 수 있다 — 기본값으로 시작하면 된다
      if (alive.current) { setLoaded(true); setMsg({ kind: 'warn', text: `저장된 설정을 불러오지 못했습니다 — ${errMessage(e)}` }) }
    }
  }, [enabled, accessToken])

  useEffect(() => { load() }, [load])

  const problem = webhookProblem(url, on)

  const onSave = async () => {
    if (saving || problem) return
    setSaving(true); setMsg(null)
    try {
      const saved = await saveNotificationSetting({
        mattermostEnabled: on,
        mattermostWebhookUrl: url.trim(),
        // 기존에 남아 있던 채널 값도 저장할 때 비운다. 전송은 웹훅 기본 채널을 사용한다.
        mattermostChannel: '',
        minSeverity: severity,
      }, accessToken)
      if (!alive.current) return
      // 서버가 정규화해 돌려준 값으로 화면을 맞춘다 — 내가 보낸 값과 다를 수 있다
      if (saved) {
        setUrl(saved.mattermostWebhookUrl || '')
      }
      setMsg({ kind: 'ok', text: on ? '알림 설정을 저장했습니다.' : '알림을 껐습니다.' })
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: `저장하지 못했습니다 — ${errMessage(e)}` })
    } finally { if (alive.current) setSaving(false) }
  }

  return (
    <div className="card-v3" id="pNotify">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>Mattermost 알림 <span className="k">NOTIFICATION</span></h3>
      <p className="cfg-help">
        화재·과열이 발생하면 서버가 Mattermost 로 알립니다. 공장이 비는 <b>20시~08시</b>에는
        관제 화면을 보는 사람이 없으므로, 이 설정이 꺼져 있으면 아침까지 아무도 알 수 없습니다.
      </p>

      {!enabled && <div className="cfg-note">시뮬레이션 모드에서는 조회되지 않습니다. 실서버 모드로 로그인하세요.</div>}

      {enabled && loaded && (
        <>
          {msg && <div className={`form-msg ${msg.kind}`} id="ntfMsg">{msg.text}</div>}

          <label className="ntf-toggle">
            <input type="checkbox" checked={on} disabled={!canOperate}
              onChange={(e) => setOn(e.target.checked)} />
            Mattermost 알림 사용
          </label>

          <div className="form-row">
            <label htmlFor="ntf-url">웹훅 URL</label>
            <input id="ntf-url" className="mono" value={url} disabled={!canOperate}
              placeholder="https://meeting.ssafy.com/hooks/..."
              onChange={(e) => setUrl(e.target.value)} />
          </div>
          {problem && <div className="form-msg err">{problem}</div>}

          <div className="form-row">
            <label htmlFor="ntf-sev">알림 기준</label>
            <select id="ntf-sev" value={severity} disabled={!canOperate}
              onChange={(e) => setSeverity(e.target.value === 'CRITICAL' ? 'CRITICAL' : 'WARNING')}>
              <option value="WARNING">경고 이상 (과열 + 화재)</option>
              <option value="CRITICAL">긴급만 (화재)</option>
            </select>
          </div>
          <div className="cfg-note">{SEVERITY_HELP[severity]}</div>

          {isAdmin && (
            <div className="gotor" style={{ marginTop: '16px' }}>
              <button type="button" className="btn-filled" onClick={onSave} disabled={saving || !!problem}>
                {saving ? '저장 중…' : '저장'}
              </button>
            </div>
          )}
          {!isAdmin && <div className="cfg-note">알림 설정은 관리자만 바꿀 수 있습니다.</div>}
        </>
      )}
    </div>
  )
}
