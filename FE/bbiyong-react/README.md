# 삐용 통합 관제 시스템 — React 버전

SSAFY 부울경 1반 팀 E101 · 공장 무인 안전 이상탐지 시스템(BBIYONG)의
관제 대시보드를 **React + Vite**로 재구현한 버전입니다.

원본(`FE UXUI 초안/index.html`)은 순수 HTML + 인라인 vanilla JS(Canvas 2D)로
작성돼 있었고, 이를 컴포넌트/훅 구조로 포팅했습니다. 화면·동작·애니메이션은
원본과 동일합니다.

## 실행

```bash
npm install
npm run dev      # 개발 서버 (http://localhost:5173)
npm run build    # 프로덕션 빌드 → dist/
npm run preview  # 빌드 결과 미리보기
```

## 구조

```
src/
├─ main.jsx                 진입점
├─ App.jsx                  탭 2개(CCTV/로봇) 마운트, SimContext 공급
├─ SimContext.js            시뮬레이션 번들 컨텍스트
├─ hooks/useSimulation.js   rAF 생명주기 · 상태 스냅샷 · 시계 · 키보드(WASD) · 액션
├─ sim/
│  ├─ mapData.js            점유격자 지도 · A* · 순찰 루프 · 분전반/화재 좌표
│  └─ Simulation.js         상태머신 + Canvas 렌더링 (CCTV·열화상·SLAM맵·신뢰도차트)
└─ components/
   ├─ Nav.jsx               상단 탭 + 이벤트 데모 + 시계
   ├─ LogList.jsx           경보/이벤트 로그 (양 화면 공용)
   ├─ cctv/                 CctvPage · Calendar · PtzPanel
   └─ robot/                RobotPage · StatusPanel · ControlPanel · MapPanel
```

## 아키텍처 메모

- **렌더링 분리**: 60fps Canvas 드로잉은 `Simulation` 인스턴스가 `requestAnimationFrame`으로
  직접 수행(명령형). React는 UI 상태(모드·배터리·온도·로그·PTZ 값 등)만 선언적으로 표시.
- **상태 브리지**: `Simulation.subscribe()` 로 스냅샷을 구독. 이산 이벤트는 즉시,
  연속 변동값(온습도·열화상 MAX)은 400ms 주기로 방출해 리렌더 비용을 억제.
- **FSM**: `patrol → dispatch(긴급출동) → goto → manual → resume` — 기획서 7.3의
  PATROL/DETECT/COMMAND/DISPATCH/VERIFY/RESUME 전이와 대응.
- **이벤트 데모**: 화재 발생 → CAM3 탐지 + 오린카 A* 긴급 출동, 분전반 과열 → 71.3°C 경보.

## 조작

- 상단 **CCTV 관제 / 순찰 로봇 관제** 탭 전환
- **WASD** 키: CCTV 탭에서는 PTZ(상하좌우), 로봇 탭에서는 이동(전진/좌/후진/우)
- 네비게이션의 **화재 발생 / 분전반 과열** 버튼으로 시나리오 A/B 재생
- 로그 항목 클릭 시 로봇 관제 탭으로 이동
