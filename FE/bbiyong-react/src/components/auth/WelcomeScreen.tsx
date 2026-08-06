// 진입(랜딩) 화면의 **앞면** — 히어로(브랜드·CTA) + 하단 2연 통계 카드.
//
// 🔴 배경 순찰 씬은 여기 없다 (S15P11E101-808). 씬은 웰컴과 로그인의 공통 부모
// (AuthFlow)에 있는 PatrolScene 이 그린다 — 로그인으로 넘어가도 언마운트되지 않아야
// 로봇이 멈추지 않는다. 이 컴포넌트는 "로그인으로 밀려나며 사라지는 쪽"만 담는다.
//
// v3 디자인 시스템 "플로팅 씬" 배치 — 확정 시안 welcome-v5-B2(하단 2연 카드)를 그대로 이식했다.
// 화면 끝까지 밝은 씬을 깔고, 정보는 그 위에 뜬다 — 좌우로 칸을 나누지 않는다.
// 레퍼런스의 좌측 로봇 목록 패널은 가져오지 않는다 — 우리 화면의 좌측은 히어로(브랜드·CTA)다.
//
// 색·타이포·radius·그림자는 한 값도 여기 적지 않는다. styles/tokens.css 의 --bb-* 를
// styles/app.css 의 .welcome-* 규칙이 참조한다.

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 🔶 [더미 데이터 — 실측/실데이터 아님]                                      ║
// ║ 🔴 실데이터 연동 시 이 블록을 통째로 지운다.                                ║
// ║ 🔴 이 화면 밖 인용 금지 · docs/실측_데이터.md 와 아무 관계가 없다.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// 로그인 전 랜딩이라 붙일 실데이터가 없다. 값을 비워 두면 "불러오기 실패"처럼 읽혀서
// 사용자 승인(2026-08-06) 아래 장식용 더미를 넣었다.
//
// [A] 누적 순찰 시간 — 우리 제품이 운용하는 순찰 로봇은 **1대**다(live/config.ts ROBOT_ID).
// 대수가 많은 물류 로봇 레퍼런스의 숫자를 그대로 베끼면 거짓말이 된다.
// 아래는 1대가 충전을 껴 가며 하루 5~8.5시간 순찰하는, 배치 20일차 기준 일별 순찰 시간(h).
const PATROL_HOURS_BY_DAY = [
  5.2, 6.1, 4.8, 6.9, 5.5, 7.2, 6.4, 5.0, 6.8, 7.6,
  6.0, 5.7, 7.1, 8.2, 6.6, 5.9, 7.4, 8.5, 6.3, 5.3,
]
// 총계는 배열의 합으로 계산한다 — 손으로 적으면 막대 합과 어긋나고, 그 어긋남이 눈에 띈다.
const PATROL_HOURS_TOTAL = PATROL_HOURS_BY_DAY.reduce((a, b) => a + b, 0)   // 128.5 h
// 미니 차트는 "추세의 인상"만 준다 — 축·격자선·범례·툴팁 없음. 컨테이너가 30px 라
// 4.8~8.5h 가 16~29px 로 들어가는 배율. 마지막 3개(최근 3일)만 강조.
const SPARK_PX_PER_HOUR = 3.4

// [B] 예상 구동 가능 시간 — [A]와 모순 없이 맞춘 값이다.
// 질문이 다르다: [A]는 "지금까지 얼마나 돌았나"(지나온 것),
//               [B]는 "지금 배터리로 앞으로 얼마나 더 도나"(남은 것) — 반드시 배터리 68%와 정합
//               (68% 는 PatrolScene 의 로봇 상태 카드가 쓰는 값이다).
// 모델: 68% → 예비 10%까지 남은 58%p 를 20구간으로 쪼개고, 구간마다 얻어지는 순찰 시간(h)을
// 적는다. 저 SoC 로 갈수록 전압이 떨어져 같은 %p 라도 실사용 시간이 조금씩 줄어드는 형태다.
// 합계 검산: 20개 합 ≈ 2.53h. 1회 만충(100→10%, 90%p) 환산 시 90/58 × 2.53 ≈ 3.9h —
// [A]의 "하루 5~8.5h"는 하루 1.5~2회 충전을 낀 값이므로 서로 모순되지 않는다.
// 🔴 합계는 이 배열에서 계산한다(손으로 적지 않는다).
const RUNTIME_BLOCKS_H = [
  0.137, 0.136, 0.135, 0.134, 0.133, 0.132, 0.131, 0.130, 0.129, 0.128,
  0.127, 0.126, 0.124, 0.123, 0.121, 0.120, 0.118, 0.116, 0.114, 0.112,
]
// ── 더미 블록 끝 ────────────────────────────────────────────────────────────

// 남은 시간 램프: remaining[i] = blocks[i..끝] 의 합. remaining[0] 이 곧 총계다.
// i 번째 막대 = 그 시점 이후 남은 시간의 합 — 왼쪽 첫 막대가 곧 총계이고 오른쪽으로 0 에
// 수렴하는 단조 하강 램프다. [A]의 불규칙한 히스토그램과 형태로 구분된다.
const RUNTIME_REMAINING_H = RUNTIME_BLOCKS_H.map(
  (_, i) => RUNTIME_BLOCKS_H.slice(i).reduce((a, b) => a + b, 0),
)
const RUNTIME_TOTAL_H = RUNTIME_REMAINING_H[0]                 // ≈ 2.53 h
const RUNTIME_PX_PER_HOUR = 29 / RUNTIME_TOTAL_H                // 첫 막대가 컨테이너(30px)에 딱 맞게

// 🔴 진입 애니메이션(welcomeHeroRise / welcomeRise)은 fill-mode:both 라 끝난 뒤에도
// transform/opacity 를 계속 강제한다. 그 상태로는 전환용 transition(.authflow.is-login …)이
// 씹혀 히어로가 밀려나지 않는다 — 애니메이션이 끝나는 즉시 지운다(시안이 브라우저에서
// 실제로 확인하고 넣은 처리다). 자기 자신의 애니메이션만 본다(자식 것이 버블링된다).
const clearEntryAnim = (e: React.AnimationEvent<HTMLElement>) => {
  if (e.target === e.currentTarget) e.currentTarget.style.animation = 'none'
}

export default function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  return (
    <>
      {/* ── 히어로: 밝은 씬 위이므로 유리 패널을 쓴다(어두운 영상 위엔 금지) ── */}
      <section className="welcome-hero" onAnimationEnd={clearEntryAnim}>
        <div className="welcome-eyebrow mono">
          <i />SYSTEM ONLINE
          <span className="sep">SSAFY 부울경 1반 · 팀 E101</span>
        </div>

        <h1 className="welcome-brand">
          삐용<span className="dot">.</span><span className="en mono">BBIYONG</span>
        </h1>

        <p className="welcome-tag">공장 무인 안전<br />이상탐지 통합 관제 시스템</p>

        <p className="welcome-desc">
          순찰 로봇 오린카를 웹 콘솔에서 원격으로 운용합니다.<br />
          현장의 이상 징후를 상시 감시하고, 발생 즉시 대응 체계로 연결합니다.
        </p>

        <div className="welcome-cta-row">
          {/* Filled CTA 는 화면당 1개 */}
          <button className="welcome-cta" onClick={onEnter}>관제 시스템 접속</button>
        </div>

        <div className="welcome-foot mono">BBIYONG CONTROL · v1.0 · © 2026 E101</div>
      </section>

      {/* ── 하단 통계 2연 카드 — 왼쪽 = 지나온 것(누적) · 오른쪽 = 남은 것(예상).
           수치는 위의 [더미 데이터] 블록에서 온다. 장식이라 스크린리더에서 감춘다 —
           읽어 줘 봐야 사실이 아닌 값이다.
           ⚠ 두 스파크라인은 배율이 다르다(128.5h vs 2.5h) — 막대 높이를 카드끼리
           비교하면 안 된다. 각 카드 안에서만 의미가 있다.
           🔴 로그인 상태에서는 함께 사라진다(S15P11E101-808) — 스크림 아래 반쯤 흐려진
           채 남으면 읽을 수 없는 죽은 요소가 된다. 규칙은 app.css 의 .authflow 절. */}
      <div className="welcome-stats" aria-hidden="true" onAnimationEnd={clearEntryAnim}>
        <div className="welcome-stat">
          <div className="welcome-stat__t">누적 순찰 시간</div>
          <div className="welcome-stat__v">
            <b className="mono">{PATROL_HOURS_TOTAL.toFixed(1)}</b><span>/ h</span>
          </div>
          <div className="welcome-spark">
            {PATROL_HOURS_BY_DAY.map((h, i) => (
              <i
                key={i}
                style={{
                  height: `${(h * SPARK_PX_PER_HOUR).toFixed(1)}px`,
                  background: i >= PATROL_HOURS_BY_DAY.length - 3 ? 'var(--bb-ok)' : undefined,
                }}
              />
            ))}
          </div>
        </div>
        <div className="welcome-stat">
          <div className="welcome-stat__t">예상 구동 가능 시간</div>
          <div className="welcome-stat__v">
            <b className="mono">{RUNTIME_TOTAL_H.toFixed(1)}</b><span>/ h</span>
          </div>
          <div className="welcome-spark">
            {RUNTIME_REMAINING_H.map((h, i) => (
              <i
                key={i}
                style={{
                  height: `${(h * RUNTIME_PX_PER_HOUR).toFixed(1)}px`,
                  // 꼬리 3칸 = 예비 구간(배터리 10% 부근). 주의색으로 "곧 충전"이 읽히게 한다.
                  background: i >= RUNTIME_REMAINING_H.length - 3 ? 'var(--bb-warn)' : undefined,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
