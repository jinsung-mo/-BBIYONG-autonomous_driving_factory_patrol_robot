import { useLive } from '../../live/LiveContext.tsx'
import { useFleet } from '../../live/FleetContext.tsx'
import { count, pct } from '../../live/dashboard.ts'

// 관제 상단 요약 띠 — GET /api/dashboard/stats
//
// 텔레메트리는 지금 이 순간의 로봇 한 대만 말해 준다. 편성 전체의 대수와
// 오늘 누적 이벤트는 서버 집계로만 알 수 있어서 이 줄이 필요하다.
//
// 조회·갱신은 FleetProvider 가 맡는다(S15P11E101-591) — 같은 응답을 로봇 현황과
// 조회 대상 선택이 함께 쓰므로, 여기서 또 부르면 같은 것을 두 번 긁는다.
export default function SummaryBar() {
  const { enabled } = useLive()
  const { stats, error, equipmentSummary, equipments, equipmentName } = useFleet()

  // 시뮬레이션 모드에는 서버 집계가 없다. 빈 카드를 띄우느니 줄 자체를 내보내지 않는다.
  if (!enabled) return null
  if (!stats && !error) return null

  const eq = equipmentSummary
  // 과열 설비가 어디인지까지 말해 준다 — 숫자만 보고는 현장에 갈 수 없다.
  // 평소에는 줄을 만들지 않고, 과열이 있을 때만 나타난다.
  const hotIds = equipments
    .filter((e: any) => String(e?.status || '').toUpperCase() === 'OVER')
    .map((e: any) => equipmentName(e?.equipmentId))

  const s = stats?.summary
  const t = stats?.today

  return (
    <div className="sumbar" id="pSummary">
      <div className="sumcard">
        <span>가동 중 로봇</span>
        <b className="num">{count(s?.activeRobots)}<i>/ {count(s?.totalRobots)}</i></b>
      </div>
      <div className="sumcard">
        <span>온라인</span>
        <b className="num">{count(s?.onlineRobots)}<i>대</i></b>
      </div>
      <div className="sumcard">
        <span>충전 중</span>
        <b className="num">{count(s?.chargingRobots)}<i>대</i></b>
      </div>
      <div className="sumcard">
        <span>평균 배터리</span>
        <b className="num">{pct(s?.avgBattery)}</b>
      </div>
      <div className="sumcard">
        <span>오늘 이벤트</span>
        <b className="num">{count(t?.eventCount)}<i>건</i></b>
      </div>
      {/* 긴급·미해결은 0이 아닐 때만 색으로 끌어올린다 — 평소에 빨간 숫자가 상주하면 무뎌진다 */}
      <div className={`sumcard${(t?.criticalEvents ?? 0) > 0 ? ' hot' : ''}`}>
        <span>오늘 긴급</span>
        <b className="num">{count(t?.criticalEvents)}<i>건</i></b>
      </div>
      <div className={`sumcard${(t?.unresolvedEvents ?? 0) > 0 ? ' warn' : ''}`}>
        <span>미해결</span>
        <b className="num">{count(t?.unresolvedEvents)}<i>건</i></b>
      </div>
      {/* 설비 집계는 서버가 줄 때만 낸다(S15P11E101-630) — 예전 서버에는 없는 필드다 */}
      {eq && (
        <div className="sumcard">
          <span>설비 정상</span>
          <b className="num">{count(eq.normalEquipments)}<i>/ {count(eq.totalEquipments)}</i></b>
        </div>
      )}
      {eq && (
        <div className={`sumcard${(eq.overheatingEquipments ?? 0) > 0 ? ' hot' : ''}`}>
          <span>설비 과열</span>
          <b className="num">{count(eq.overheatingEquipments)}<i>대</i></b>
        </div>
      )}
      {/* 미점검은 0이 아닐 때만 — 평소에 상주하면 눈에 안 들어온다 */}
      {eq && (eq.unknownEquipments ?? 0) > 0 && (
        <div className="sumcard warn">
          <span>설비 미점검</span>
          <b className="num">{count(eq.unknownEquipments)}<i>대</i></b>
        </div>
      )}
      {hotIds.length > 0 && (
        <div className="sumhot" id="pSummaryHot">과열 설비 — {hotIds.join(' · ')}</div>
      )}
      {error && <div className="sumerr" title={error}>집계 갱신 실패 — 표시된 값은 최신이 아닐 수 있습니다.</div>}
    </div>
  )
}
