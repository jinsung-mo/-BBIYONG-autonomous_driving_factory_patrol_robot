import { useState } from 'react'
import { useSettings } from '../../settings/SettingsContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import NotifyPanel from './NotifyPanel.tsx'
import UsersPanel from './UsersPanel.tsx'
import EquipmentPanel from './EquipmentPanel.tsx'
import InspectionPanel from '../ops/InspectionPanel.tsx'
import KpiRow from '../robot/KpiRow.tsx'
import { useInspection } from '../../live/inspection.ts'

// 설정 (S15P11E101-685: 속도 상한, 열화상 임계온도, 시연 경보, 순찰 지점 설정 항목 삭제)
// (S15P11E101-836: 구역·설비 현황 제거)
// (S15P11E101 콘솔 정리: 점검 지점·분전반 임계온도 관리를 운영 탭에서 설정으로 이동)
export default function ConfigPage() {
  const { reset } = useSettings()
  const { locked } = useAuth()

  // 점검 지점(AprilTag). 패널과 지도가 같은 값을 봐야 한다 — 공유 스토어(useInspection)를 쓴다.
  const inspection = useInspection()
  const [inspSel, setInspSel] = useState<string | null>(null)

  return (
    <section id="pgConfig" className="page on v3-theme nav-page">
      <div className="nav-hero">
        <div className="nav-title">
          <h2>시스템 설정</h2>
          <span className="nav-sub">NOTIFICATIONS · INSPECTION · USERS</span>
        </div>
        <KpiRow />
      </div>
      {/* 잠금 중에는 설정을 바꿀 수 없다 */}
      <fieldset className="lockfs" disabled={locked}>
        <div className="nav-stage">
          <aside className="nav-side" aria-label="알림·임계온도·점검 지점 설정">
            <NotifyPanel />

            {/* 분전반 임계온도(S15P11E101-836). 삐용봇이 탐지한 분전반의 과열 기준을 정한다. */}
            <EquipmentPanel />

            <div className="card-v3">
              <h3 style={{ margin: 0, marginBottom: '12px' }}>초기화 <span className="k">RESET</span></h3>
              <p className="cfg-help">모든 설정을 기본값으로 되돌립니다. 되돌린 값은 즉시 관제 화면에 반영됩니다.</p>
              <button type="button" className="btn-tonal" style={{ color: '#B4655C' }} onClick={reset}>기본값으로 되돌리기</button>
            </div>
          </aside>

          <div className="nav-canvas">
            {/* 점검 지점 관리(S15P11E101-787) — 운영 탭에서 이동 */}
            <InspectionPanel
              candidates={inspection.candidates}
              points={inspection.points}
              onConfirm={(candidateId, cname) => {
                inspection.confirm(candidateId, cname)
                setInspSel(`pt-${candidateId}`)
              }}
              onReject={inspection.reject}
              onRename={inspection.rename}
              onToggle={inspection.setEnabled}
              onDelete={inspection.remove}
              onPublish={inspection.publishAll}
              selectedId={inspSel}
              onSelect={setInspSel}
            />
            <UsersPanel />
          </div>
        </div>
      </fieldset>
    </section>
  )
}
