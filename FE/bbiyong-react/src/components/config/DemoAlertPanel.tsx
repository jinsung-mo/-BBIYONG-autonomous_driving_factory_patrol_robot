import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.tsx'
import { errMessage } from '../../live/errors.ts'
import { triggerDemoAlert, type DemoAlertType } from '../../live/eventSimulations.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { useFleet } from '../../live/FleetContext.tsx'

const COOLDOWN_MS = 5_000
const LABEL: Record<DemoAlertType, string> = { FIRE: '화재', OVERHEAT: '과열' }

// 실제 이벤트 경로를 검증하는 시연용 제어다. 성공 메시지는 이벤트 접수만 말한다.
// 외부 알림 전달 완료는 비동기 재시도 대상이라 이 UI가 성공으로 단정하지 않는다.
export default function DemoAlertPanel() {
  const { enabled } = useLive()
  const { selected: robotId } = useFleet()
  const { accessToken } = useAuth()
  const [pending, setPending] = useState<DemoAlertType | null>(null)
  const [until, setUntil] = useState<Partial<Record<DemoAlertType, number>>>({})
  const [now, setNow] = useState(Date.now())
  const [msg, setMsg] = useState<{ kind: string, text: string } | null>(null)

  useEffect(() => {
    if (!Object.values(until).some((time) => time && time > now)) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [until, now])

  const cooling = (type: DemoAlertType) => (until[type] || 0) > now
  const secondsLeft = (type: DemoAlertType) => Math.max(1, Math.ceil(((until[type] || 0) - now) / 1000))

  const trigger = async (type: DemoAlertType) => {
    if (pending || cooling(type)) return
    setPending(type)
    setMsg(null)
    try {
      await triggerDemoAlert(type, robotId, accessToken)
      setUntil((prev) => ({ ...prev, [type]: Date.now() + COOLDOWN_MS }))
      setMsg({ kind: 'ok', text: `${LABEL[type]} 테스트 이벤트를 발생시켰습니다.` })
    } catch (e: any) {
      if (e?.status === 429) {
        setUntil((prev) => ({ ...prev, [type]: Date.now() + COOLDOWN_MS }))
        setMsg({ kind: 'warn', text: `같은 테스트 이벤트는 5초 후 다시 발생시킬 수 있습니다.` })
      } else if (e?.status === 403) {
        setMsg({ kind: 'err', text: '관리자 권한이 필요합니다.' })
      } else if (e?.status === 404) {
        setMsg({ kind: 'err', text: '시연 경보 기능을 사용할 수 없습니다. 서버 배포 상태를 확인하세요.' })
      } else {
        setMsg({ kind: 'err', text: `테스트 이벤트를 발생시키지 못했습니다 — ${errMessage(e)}` })
      }
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="panel" id="pDemoAlert">
      <h3>시연 경보 발생 <span className="k">DEMO ALERT</span></h3>
      <p className="cfg-help">
        실제 화재·과열 이벤트 처리 경로를 실행합니다. 관제 경보와 이벤트 로그에서 결과를 확인하세요.
      </p>
      {!enabled && <div className="cfg-note">실서버 모드에서만 시연 경보를 발생시킬 수 있습니다.</div>}
      {enabled && (
        <>
          {msg && <div className={`form-msg ${msg.kind}`} id="demoAlertMsg">{msg.text}</div>}
          <div className="gotor">
            {(['FIRE', 'OVERHEAT'] as DemoAlertType[]).map((type) => (
              <button
                key={type}
                type="button"
                className={`dbtn ${type === 'FIRE' ? 'stop' : ''}`}
                onClick={() => trigger(type)}
                disabled={!!pending || cooling(type)}
              >
                {pending === type
                  ? `${LABEL[type]} 발생 중…`
                  : cooling(type)
                    ? `${LABEL[type]} 발생 (${secondsLeft(type)}초)`
                    : `${LABEL[type]} 발생`}
              </button>
            ))}
          </div>
          <div className="cfg-note">반복 발생은 이벤트 유형별로 5초간 제한됩니다.</div>
        </>
      )}
    </div>
  )
}
