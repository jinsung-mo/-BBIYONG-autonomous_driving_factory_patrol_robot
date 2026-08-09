import { useState } from 'react'
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
// 그 뒤 이 파일에서 import 하고 아래 SECTIONS 배열에 한 줄 + 렌더 분기 한 줄을 넣으면 돌아온다.
// 각 패널이 부르던 API·스토어(inspection.ts · adminUsers.ts 등)는 지우지 않았다 — 되살릴 때
// 그쪽까지 복구해야 하면 일이 커지기 때문이다.
//
// 🔴 UsersPanel 제거의 부작용 — 이건 알고 있어야 한다. 그 화면이 **권한을 승격시키는 유일한
// UI** 였다(`canOperate = isAdminRole(...)`, AuthContext.tsx:354). 새로 가입한 계정은
// '사용자'로 시작하므로, 이제 앱 안에서는 관리자로 올릴 방법이 없다. 서버에 직접 요청해야 한다:
//   PATCH /api/admin/users   (요청 형태는 live/adminUsers.ts 의 changeUserRole 참고)
// 좌측 목록과 우측 본문이 같은 배열에서 나온다 — 항목을 추가하려면 여기 한 줄과
// 아래 렌더 분기 한 줄이면 된다. 둘이 어긋나면 목록에 있는데 눌러도 빈 화면이 된다.
type CfgKey = 'power' | 'reset'
const SECTIONS: Array<{ key: CfgKey, label: string }> = [
  { key: 'power', label: 'Orin 전력 모드' },
  { key: 'reset', label: '초기화' },
]

export default function ConfigPage() {
  const { reset } = useSettings()
  const { locked } = useAuth()
  const [sec, setSec] = useState<CfgKey>('power')

  return (
    <section id="pgConfig" className="page on v3-theme nav-page">
      {/* 제목(.nav-hero)과 KPI 는 App.tsx 의 공통 껍데기가 그린다(S15P11E101-875) —
          네 화면이 세로 슬라이드로 이어지므로 머리가 화면마다 다시 그려지면 탭을 옮길 때
          같은 자리에서 깜빡인다. 제목 문구도 App.tsx 의 표에 있다. */}
      {/* 잠금 중에는 설정을 바꿀 수 없다 */}
      <fieldset className="lockfs" disabled={locked}>
        {/* 좌측 항목 목록 + 우측 제어 (S15P11E101-876) — 아이패드 설정과 같은 구조.
            `.nav-stage` 를 그대로 쓰므로 좌측 폭·열 간격이 지도·카메라와 자동으로 같다
            (--nx-side-w · gap 24px). 값을 따로 적지 않는 것이 핵심이다. */}
        <div className="nav-stage">
          <aside className="nav-side cfg-nav" role="tablist" aria-label="시스템 설정 항목">
            {SECTIONS.map((s) => (
              <button
                key={s.key} type="button" role="tab"
                id={`cfgtab-${s.key}`}
                aria-selected={sec === s.key}
                aria-controls={`cfgpanel-${s.key}`}
                className={sec === s.key ? 'on' : ''}
                onClick={() => setSec(s.key)}
              >
                {s.label}
              </button>
            ))}
          </aside>

          {/* 선택한 항목 하나만 그린다. 우측만 스크롤한다 — 예전 단일 열은 부모가
              overflow:hidden 이라 목록이 길어지면 맨 아래 카드에 아예 닿지 못했다. */}
          <div
            className="nav-canvas cfg-canvas"
            role="tabpanel" id={`cfgpanel-${sec}`} aria-labelledby={`cfgtab-${sec}`}
          >
            {sec === 'power' && <OrinPowerPanel />}

            {sec === 'reset' && (
              <div className="card-v3">
                <h3 style={{ margin: 0, marginBottom: '12px' }}>초기화 <span className="k">RESET</span></h3>
                <p className="cfg-help">모든 설정을 기본값으로 되돌립니다. 되돌린 값은 즉시 관제 화면에 반영됩니다.</p>
                <button type="button" className="btn-tonal" style={{ color: '#B4655C' }} onClick={reset}>기본값으로 되돌리기</button>
              </div>
            )}
          </div>
        </div>
      </fieldset>
    </section>
  )
}
