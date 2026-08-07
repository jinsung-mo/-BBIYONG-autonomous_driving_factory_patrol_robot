import { useSettings, DEFAULT_SETTINGS } from '../../settings/SettingsContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import NotifyPanel from './NotifyPanel.tsx'
import UsersPanel from './UsersPanel.tsx'
import KpiRow from '../robot/KpiRow.tsx'

// 설정 (S15P11E101-685: 속도 상한, 열화상 임계온도, 시연 경보, 순찰 지점 설정 항목 삭제)
// (S15P11E101-836: 구역·설비 현황 제거 — 설비(분전반) 임계온도 관리는 운영탭으로 이동)
export default function ConfigPage() {
  const { reset } = useSettings()
  const { locked } = useAuth()

  return (
    <section id="pgConfig" className="page on v3-theme nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>시스템 설정</h2>
          <span className="nav-sub">NOTIFICATIONS · USERS</span>
        </div>
        <KpiRow />
      </div>
      {/* 잠금 중에는 설정을 바꿀 수 없다 */}
      <fieldset className="lockfs" disabled={locked}>
        <div className="nav-stage">
          <aside className="nav-side" aria-label="기본 제어 및 알림 설정">
            <NotifyPanel />

            <div className="card-v3">
              <h3 style={{ margin: 0, marginBottom: '12px' }}>초기화 <span className="k">RESET</span></h3>
              <p className="cfg-help">모든 설정을 기본값으로 되돌립니다. 되돌린 값은 즉시 관제 화면에 반영됩니다.</p>
              <button type="button" className="btn-tonal" style={{ color: '#B4655C' }} onClick={reset}>기본값으로 되돌리기</button>
            </div>
          </aside>

          <div className="nav-canvas">
            <UsersPanel />
          </div>
        </div>
      </fieldset>
    </section>
  )
}
