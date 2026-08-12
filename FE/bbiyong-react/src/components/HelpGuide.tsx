import { useState } from 'react'
import Modal from './ui/Modal.tsx'

// 사용설명서(S15P11E101-911). 관제센터 안전감시 담당자(50대 대상)가 서비스를 쉽게
// 이해하도록, 큰 글씨·쉬운 말·단계 번호로 각 화면 사용법을 안내한다. 전문 용어는 최소화하고
// "무엇을 보는 곳인지 → 무엇을 할 수 있는지 → 급할 때 이렇게" 순서로 적는다.

type SectionKey = 'intro' | 'map' | 'camera' | 'events' | 'alarm'

const SECTIONS: Array<{ key: SectionKey, label: string, icon: JSX.Element }> = [
  { key: 'intro', label: '처음 오셨나요?', icon: <IconHome /> },
  { key: 'map', label: '지도 화면', icon: <IconMap /> },
  { key: 'camera', label: '카메라 화면', icon: <IconCamera /> },
  { key: 'events', label: '이벤트(기록)', icon: <IconList /> },
  { key: 'alarm', label: '경보가 울리면', icon: <IconBell /> },
]

export default function HelpGuide({ onClose }: { onClose: () => void }) {
  const [sec, setSec] = useState<SectionKey>('intro')

  return (
    <Modal title="사용설명서" onClose={onClose} width={860} className="help-guide">
      <div className="help-layout">
        {/* 왼쪽 큰 목차 — 큰 버튼으로 눌러 이동한다 */}
        <nav className="help-nav" aria-label="설명서 목차">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`help-nav-btn${sec === s.key ? ' on' : ''}`}
              aria-current={sec === s.key}
              onClick={() => setSec(s.key)}
            >
              <span className="help-nav-ico" aria-hidden="true">{s.icon}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        {/* 오른쪽 본문 */}
        <div className="help-body" role="region" aria-live="polite">
          {sec === 'intro' && <Intro />}
          {sec === 'map' && <MapHelp />}
          {sec === 'camera' && <CameraHelp />}
          {sec === 'events' && <EventsHelp />}
          {sec === 'alarm' && <AlarmHelp />}
        </div>
      </div>
    </Modal>
  )
}

// ── 각 섹션 본문 ──────────────────────────────────────────────

function Intro() {
  return (
    <>
      <h4 className="help-h">삐용(BBIYONG)은 무엇을 하나요?</h4>
      <p className="help-lead">
        <b>삐용</b>은 공장 안을 스스로 돌아다니며 <b>불(화재)</b>과 <b>뜨거운 곳(과열)</b>을
        찾아내는 순찰 로봇입니다. 이 화면은 그 로봇을 <b>지켜보고 다루는 관제 화면</b>입니다.
      </p>
      <div className="help-cards">
        <HelpCard icon={<IconMap />} title="① 지도 화면">
          로봇이 <b>지금 어디에 있는지</b>, 어디를 돌고 있는지 한눈에 봅니다.
        </HelpCard>
        <HelpCard icon={<IconCamera />} title="② 카메라 화면">
          로봇이 보는 <b>실시간 영상</b>과 <b>열(온도) 화면</b>을 봅니다.
        </HelpCard>
        <HelpCard icon={<IconList />} title="③ 이벤트 화면">
          <b>언제 무슨 일</b>이 있었는지(화재·과열) 기록을 보고 영상을 확인합니다.
        </HelpCard>
      </div>
      <p className="help-tip">
        <b>화면 바꾸기:</b> 맨 위 줄의 <b>지도 · 카메라 · 이벤트</b> 글자를 누르면 그 화면으로 바뀝니다.
        이 설명서는 언제든 오른쪽 위 <b>“사용설명서”</b> 버튼으로 다시 열 수 있습니다.
      </p>
    </>
  )
}

function MapHelp() {
  return (
    <>
      <h4 className="help-h">지도 화면 — 로봇이 어디 있는지 봅니다</h4>
      <ol className="help-steps">
        <li><b>로봇 위치</b>가 지도 위에 표시됩니다. 로봇이 움직이면 표시도 같이 움직입니다.</li>
        <li>
          오른쪽 위 <b>2D · 3D · 네비게이션</b> 버튼으로 보는 방식을 바꿉니다.
          <ul>
            <li><b>2D</b> — 위에서 내려다본 평면 지도</li>
            <li><b>3D</b> — 입체로 보는 지도(벽·장애물이 튀어나와 보입니다)</li>
            <li><b>네비게이션</b> — 로봇을 가까이에서 따라다니며 봅니다</li>
          </ul>
        </li>
        <li>오른쪽의 <b>＋ / －</b> 버튼으로 <b>크게·작게</b>, <b>⛶</b> 버튼으로 <b>전체 화면</b>으로 봅니다.</li>
        <li><b>빨강·주황 핀</b>이 지도에 뜨면 그 자리에서 화재·과열이 있었다는 뜻입니다. 핀을 누르면 <b>그때 영상</b>을 봅니다.</li>
      </ol>
      <p className="help-tip">
        지도 왼쪽 아래에는 <b>로봇 상태</b>(배터리·연결)와 최근 <b>이벤트 기록</b>이 함께 보입니다.
      </p>
    </>
  )
}

function CameraHelp() {
  return (
    <>
      <h4 className="help-h">카메라 화면 — 로봇의 눈으로 봅니다</h4>
      <ol className="help-steps">
        <li>큰 화면은 로봇 앞을 보는 <b>일반 카메라</b>, 작은 화면은 <b>열(온도) 카메라</b>입니다.</li>
        <li>작은 화면을 <b>두 번 누르면</b> 큰 화면과 자리가 바뀝니다. 온도를 크게 보고 싶을 때 씁니다.</li>
        <li>오른쪽의 <b>＋ / －</b>로 화면을 <b>크게·작게</b>, <b>⛶</b>로 <b>전체 화면</b>으로 봅니다.</li>
        <li>
          왼쪽에는 <b>수동 조작</b> 버튼이 있습니다(권한이 있는 경우). 방향 버튼으로 로봇을 직접 움직이거나
          카메라 각도를 올리고 내릴 수 있습니다.
        </li>
      </ol>
      <p className="help-tip">
        열 카메라의 숫자는 <b>가장 뜨거운 곳의 온도(℃)</b>입니다. 이 숫자가 높아지면 과열을 의심합니다.
      </p>
    </>
  )
}

function EventsHelp() {
  return (
    <>
      <h4 className="help-h">이벤트 화면 — 무슨 일이 있었는지 봅니다</h4>
      <ol className="help-steps">
        <li>화재·과열이 생기면 <b>목록에 한 줄씩</b> 쌓입니다. 위에 있을수록 <b>최근</b> 일입니다.</li>
        <li>
          색과 딱지로 <b>심각한 정도</b>를 알립니다 —
          <b> 화재는 “긴급”</b>, <b>과열은 “경고”</b>입니다.
        </li>
        <li>한 줄을 <b>누르면</b> 자세한 내용과 <b>그때 찍힌 영상</b>(앞뒤 몇 초)이 열립니다.</li>
        <li>
          확인하고 조치를 마쳤으면 <b>“해결”</b> 버튼을 누릅니다. 처리한 일은 목록에서 사라지고
          <b> 남은 일</b>만 보이게 됩니다.
        </li>
        <li>왼쪽 <b>필터</b>로 화재만, 과열만, 기간별로 골라 볼 수 있습니다.</li>
      </ol>
      <p className="help-tip">
        로봇 <b>연결/해제</b> 같은 시스템 알림도 목록에 남지만, 이런 항목은 영상이 없습니다(불·열이 아니기 때문입니다).
      </p>
    </>
  )
}

function AlarmHelp() {
  return (
    <>
      <h4 className="help-h">경보가 울리면 — 이렇게 하세요</h4>
      <ol className="help-steps help-steps-lg">
        <li><b>화면 오른쪽 위에 경보 알림</b>이 뜹니다. 어떤 종류(화재/과열)인지 먼저 봅니다.</li>
        <li><b>지도</b>에서 빨강·주황 <b>핀</b>을 누르거나, <b>이벤트</b> 목록에서 방금 항목을 눌러 <b>영상</b>을 확인합니다.</li>
        <li><b>카메라</b> 화면으로 현장을 실시간으로 살핍니다. 필요하면 열 카메라로 온도를 봅니다.</li>
        <li>정해진 <b>현장 대응 절차</b>(신고·확인·대피 안내 등)를 진행합니다.</li>
        <li>상황이 끝나면 이벤트에서 <b>“해결”</b>을 눌러 처리 완료로 기록합니다.</li>
      </ol>
      <p className="help-tip help-tip-warn">
        <b>영상이 바로 안 보일 수 있습니다.</b> 방금 생긴 일은 로봇이 영상을 올리는 데
        <b> 20~30초</b>가 걸립니다. 잠시 뒤 다시 눌러 보세요.
      </p>
    </>
  )
}

function HelpCard({ icon, title, children }: { icon: JSX.Element, title: string, children: React.ReactNode }) {
  return (
    <div className="help-card">
      <span className="help-card-ico" aria-hidden="true">{icon}</span>
      <b className="help-card-title">{title}</b>
      <p>{children}</p>
    </div>
  )
}

// ── 아이콘(단순 라인 SVG) ─────────────────────────────────────
function IconHome() {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></svg>
}
function IconMap() {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></svg>
}
function IconCamera() {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h3l2-2h8l2 2h3v12H3z" /><circle cx="12" cy="13" r="3.5" /></svg>
}
function IconList() {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>
}
function IconBell() {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" /><path d="M10 21a2 2 0 004 0" /></svg>
}
