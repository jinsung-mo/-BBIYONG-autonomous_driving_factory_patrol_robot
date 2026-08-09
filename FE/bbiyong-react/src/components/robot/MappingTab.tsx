import { useAuth } from '../../auth/AuthContext.tsx'
import RoutePanel from '../ops/RoutePanel.tsx'
import { useInspection } from '../../live/inspection.ts'

// 지도 페이지의 '매핑' 탭 (S15P11E101 콘솔 정리 — 운영 탭에서 이동).
//
// 맵 모델링(SLAM MAPPING) 컨트롤은 이제 서브탭 줄(지도/매핑) 오른쪽에 있다
// (S15P11E101-904, App.ConsoleHeader + useMappingControl). 이 탭은 그 아래에서
// 순찰 경로 패널 하나로 맵을 크게 보여 준다 — 좌측 별도 카드가 없어 화면을 다 채운다.
export default function MappingTab() {
  const { locked } = useAuth()
  // 순찰 경로 지도에 확정 점검 지점을 얹어 준다(읽기 전용).
  const inspection = useInspection()

  return (
    <fieldset className="lockfs" disabled={locked}>
      {/* 단일 카드가 화면을 다 채운다(S15P11E101-904) — 맵(routemap)이 flex 로 크게. */}
      <div className="nav-canvas mapping-canvas">
        <RoutePanel
          title="실시간 매핑/순찰 모니터링"
          inspection={{
            candidates: inspection.candidates,
            points: inspection.points,
            selectedId: null,
          }}
        />
      </div>
    </fieldset>
  )
}
