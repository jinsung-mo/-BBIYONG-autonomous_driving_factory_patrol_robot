import { useSettings, DEFAULT_SETTINGS } from '../../settings/SettingsContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import EquipmentPanel from './EquipmentPanel.tsx'
import NotifyPanel from './NotifyPanel.tsx'
import UsersPanel from './UsersPanel.tsx'
import KpiRow from '../robot/KpiRow.tsx'

// 설정 (S15P11E101-685: 속도 상한, 열화상 임계온도, 시연 경보, 순찰 지점 설정 항목 삭제)
export default function ConfigPage() {
  const { reset } = useSettings()
  const { locked } = useAuth()

  return (
    <section id="pgConfig" className="page on sim-skin nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>시스템 설정</h2>
          <span className="nav-sub">NOTIFICATIONS · USERS · EQUIPMENT</span>
        </div>
        <KpiRow />
      </div>
      {/* 잠금 중에는 설정을 바꿀 수 없다 */}
      <fieldset className="lockfs" disabled={locked}>
        <div className="nav-stage">
          <aside className="nav-side" aria-label="기본 제어 및 알림 설정">
            <NotifyPanel />

            <div className="nx-card">
              <h3>초기화 <span className="k">RESET</span></h3>
              <p className="cfg-help">모든 설정을 기본값으로 되돌립니다. 되돌린 값은 즉시 관제 화면에 반영됩니다.</p>
              <button type="button" className="basebtn danger" onClick={reset}>기본값으로 되돌리기</button>
            </div>
          </aside>

          <div className="nav-canvas">
            <EquipmentPanel />
            <UsersPanel />
          </div>
        </div>
      </fieldset>
    </section>
  )
}
