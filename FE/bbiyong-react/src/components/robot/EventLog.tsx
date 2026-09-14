import LogList from '../LogList.tsx'

// 이벤트 로그만 떼어낸 패널.
//
// 지도 화면(상태 패널 안)과 카메라 화면 양쪽에 둔다. 무인 시간대에는 '무슨 일이
// 있었나' 를 확인하려고 화면을 옮기게 되는데, 그 사이에 새 이벤트가 올라오면
// 놓친다 — 어느 화면에 있든 로그는 눈에 들어와야 한다.
export default function EventLog() {
  return (
    <div className="panel" id="pEvents">
      <h3 className="event-title">이벤트 로그</h3>
      <LogList variant="elog" simple={true} />
    </div>
  )
}
