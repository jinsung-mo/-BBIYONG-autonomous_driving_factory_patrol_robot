import { useLive } from '../../live/LiveContext.tsx'
import { displayName } from '../../live/robotName.ts'

// 지도 탭의 '매핑중' 화면 (S15P11E101-744).
//
// 매핑이 도는 동안 지도 탭에는 확정된 지도가 없다. 그리는 중인 격자를 여기에
// 흘리면 조작자가 그것을 완성된 지도로 읽는다 — 실시간 진행은 운영 탭에서 본다.
//
// 그래서 이 화면이 할 일은 하나다. '지금 무슨 일이 벌어지고 있고, 어디서 볼 수
// 있는지' 를 말하는 것. 진행률은 로봇이 주지 않으므로 만들어 내지 않는다.
export default function MappingProgress() {
  const { robotId } = useLive()

  return (
    <div className="map-mapping" role="status" aria-live="polite">
      {/* 도는 고리는 '멈춰 있지 않다' 만 알린다. 몇 퍼센트인지는 아무도 모른다. */}
      <span className="map-mapping-spin" aria-hidden="true" />
      <b>지도를 그리는 중입니다</b>
      <span className="map-mapping-sub">
        {displayName(robotId)} 가 구역을 돌며 도면을 만들고 있습니다.
      </span>
      <span className="map-mapping-hint">
        진행 상황은 운영 탭의 실시간 지도에서 볼 수 있습니다.
        도면이 준비되면 이 화면이 3D 도면으로 바뀝니다.
      </span>
    </div>
  )
}
