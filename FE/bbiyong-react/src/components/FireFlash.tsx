import { useFireUnacknowledged } from '../live/fireAlarm.ts'

// 미확인 화재가 있는 동안 화면 전체를 적색으로 점멸시킨다 (S15P11E101-643).
//
// 공장이 비는 20시~08시에는 관제자가 화면 앞에 없을 수 있다. 상단 토스트는 가까이서
// 보고 있어야 눈에 들어오므로, 멀리서도 알아챌 수 있는 신호를 하나 더 둔다.
//
// 두 겹이다.
//  - 점멸 막(.fireflash) : 화면을 덮지만 클릭을 통과시킨다. 경보가 긴급 정지·영상 확인 같은
//    조치를 가로막으면 안 된다.
//  - 확인 띠(.fireflash-bar) : 실제로 누를 수 있는 유일한 부분. 토스트를 ✕로 닫아버려도
//    확인할 곳이 남아 있어야 점멸이 갇히지 않는다.
export default function FireFlash({ onAck }: { onAck: () => void }) {
  const active = useFireUnacknowledged()
  if (!active) return null
  return (
    <>
      <div className="fireflash" aria-hidden="true" />
      <div className="fireflash-bar" role="alert" aria-live="assertive">
        <span className="fireflash-txt">화재 경보 — 확인되지 않음</span>
        <button
          type="button"
          className="fireflash-ack"
          id="btnFireAck"
          aria-label="화재 경보 확인 — 경보음과 화면 점멸을 멈춥니다"
          onClick={onAck}
        >
          확인
        </button>
      </div>
    </>
  )
}
