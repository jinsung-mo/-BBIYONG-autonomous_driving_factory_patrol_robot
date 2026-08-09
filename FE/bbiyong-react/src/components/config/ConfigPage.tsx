import { useSettings } from '../../settings/SettingsContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import OrinPowerPanel from './OrinPowerPanel.tsx'

// 설정 (S15P11E101-685: 속도 상한, 열화상 임계온도, 시연 경보, 순찰 지점 설정 항목 삭제)
// (S15P11E101-836: 구역·설비 현황 제거)
//
// 🔴 2026-08-09 정리 [사용자 지침]: Mattermost 알림 · 분전반 임계온도 · 점검 지점 ·
// 사용자 관리 4개 패널을 제거했다. 시연 환경에서 조작할 수 없거나(임계온도를 맞출 수 있는
// 분전반이 없다) 프로덕션 단계에서 이미 끝나 있어야 할 개인화(알림 채널)라, 화면에 있어도
// 아무도 쓰지 않는 자리였다.
//
// 지운 게 아니라 **git 이 갖고 있다.** 되살리려면 (삭제 직전 커밋 `81aff99`):
//   git show 81aff99:FE/bbiyong-react/src/components/config/NotifyPanel.tsx    > src/components/config/NotifyPanel.tsx
//   git show 81aff99:FE/bbiyong-react/src/components/config/EquipmentPanel.tsx > src/components/config/EquipmentPanel.tsx
//   git show 81aff99:FE/bbiyong-react/src/components/config/UsersPanel.tsx     > src/components/config/UsersPanel.tsx
//   git show 81aff99:FE/bbiyong-react/src/components/ops/InspectionPanel.tsx   > src/components/ops/InspectionPanel.tsx
// 그 뒤 이 파일에서 import 하고 아래 .cfg-stack 안에 형제로 넣으면 그대로 돌아온다.
// 각 패널이 부르던 API·스토어(inspection.ts · adminUsers.ts 등)는 지우지 않았다 — 되살릴 때
// 그쪽까지 복구해야 하면 일이 커지기 때문이다.
//
// 🔴 UsersPanel 제거의 부작용 — 이건 알고 있어야 한다. 그 화면이 **권한을 승격시키는 유일한
// UI** 였다(`canOperate = isAdminRole(...)`, AuthContext.tsx:354). 새로 가입한 계정은
// '사용자'로 시작하므로, 이제 앱 안에서는 관리자로 올릴 방법이 없다. 서버에 직접 요청해야 한다:
//   PATCH /api/admin/users   (요청 형태는 live/adminUsers.ts 의 changeUserRole 참고)
export default function ConfigPage() {
  const { reset } = useSettings()
  const { locked } = useAuth()

  return (
    <section id="pgConfig" className="page on v3-theme nav-page">
      {/* 제목(.nav-hero)과 KPI 는 App.tsx 의 공통 껍데기가 그린다(S15P11E101-875) —
          네 화면이 세로 슬라이드로 이어지므로 머리가 화면마다 다시 그려지면 탭을 옮길 때
          같은 자리에서 깜빡인다. 제목 문구도 App.tsx 의 표에 있다. */}
      {/* 잠금 중에는 설정을 바꿀 수 없다 */}
      <fieldset className="lockfs" disabled={locked}>
        {/* 설정 섹션을 위→아래로 쌓는다(S15P11E101-814: 2열 그리드 제거).
            새 섹션을 추가하려면 이 아래에 .card-v3 하나를 형제로 넣으면 된다 — 카드 안에
            h3(제목)+p.cfg-help(설명)을 아래 패널들과 같은 형식으로 두면 같은 위계로 보인다.
            폭이 넓은 콘텐츠(그래프 등)가 필요하면 그 .card-v3 에 cfg-wide 를 더해 폭 제한을 뺀다. */}
        <div className="cfg-stack" aria-label="시스템 설정">
          {/* Orin 전력 모드 — 저성능/고성능 토글 + 부하 그래프(S15P11E101-814) */}
          <OrinPowerPanel />

          <div className="card-v3">
            <h3 style={{ margin: 0, marginBottom: '12px' }}>초기화 <span className="k">RESET</span></h3>
            <p className="cfg-help">모든 설정을 기본값으로 되돌립니다. 되돌린 값은 즉시 관제 화면에 반영됩니다.</p>
            <button type="button" className="btn-tonal" style={{ color: '#B4655C' }} onClick={reset}>기본값으로 되돌리기</button>
          </div>
        </div>
      </fieldset>
    </section>
  )
}
