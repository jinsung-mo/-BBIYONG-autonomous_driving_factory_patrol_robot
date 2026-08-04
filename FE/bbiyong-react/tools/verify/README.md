# 화면 검증 스크립트

헤드리스 Chrome 을 CDP 로 몰아 **실제로 렌더된 화면**을 재는 스크립트다.
선언된 CSS 가 아니라 화면에 나온 결과를 본다 — 그래야 `:is()` 특정도에 밀린 규칙이나
다른 요소에 가려진 버튼이 잡힌다. 자세한 배경은 [`../../docs/design.md`](../../docs/design.md).

**모든 검증은 이 폴더의 가짜 백엔드를 상대로 돈다. 실제 로봇·배포 서버로 나가는 요청은 없다.**

## 준비

```sh
# 1) 가짜 백엔드 (REST 8099 · STOMP ws://8099/ws/control · 경보 트리거 8100)
node tools/verify/serve-fake-backend.mjs

# 2) 개발 서버 — 가짜 백엔드를 보게 띄운다
VITE_REST_BASE_URL=http://127.0.0.1:8099 \
VITE_WS_URL=ws://127.0.0.1:8099/ws/control \
npm run dev -- --port 5174
```

로그인은 아무 이메일/비밀번호나 통과한다. `viewer` 가 들어간 이메일은 사용자 권한.
시뮬레이션 모드 계정은 `safety@bbiyong.io` / `bbiyong`.

## 실행

```sh
node tools/verify/check-liquidglass.mjs      # 하나만
node tools/verify/run-all.mjs                # 전부 (FAIL 이 있으면 종료코드 1)
```

환경변수로 덮을 수 있다.

| 변수 | 기본값 |
| --- | --- |
| `CHROME` | `C:/Program Files/Google/Chrome/Application/chrome.exe` |
| `APP_URL` | `http://localhost:5174/` |

스크린샷은 `shots/` 에 떨어진다(git 에 올리지 않는다).

## 무엇을 보는가

| 스크립트 | 내용 |
| --- | --- |
| `check-liquidglass` | 프레임워크 미사용 · 인공 선의 부재 · 주변색 적응 · 동심원 모서리 · 콘텐츠 비유리화 · 두 테마 명료성 · 커서 추종 부재 · 실서버 격리 |
| `check-simskin` | 스킨 적용 범위 · 게이지 값·눈금 일치 · 지표 카드 · 조작 유지 · 좁은 창 |
| `check-camfull` | 카메라 확대 · 열화상 PiP · 두 캔버스 갱신 · 경보 우선순위 · 나가는 길 |
| `check-dpad` | 실제 키 입력으로 방향 패드 눌림 측정 · 눌린 글자 대비 |
| `check-usermenu` | 실제 포인터로 계정 메뉴 클릭 가능 여부 · 겹침 순서 |
| `check-643` | 화재 점멸 · 확인 처리 · 0.91Hz · 저감 모션 |
| `check-653` (+`-boundary`, `-restore`) | 조작 잠금 · 긴급 정지 예외 · 1시간 경계 · 상한 로그아웃 |
| `check-508` | 세션 만료 · 유휴 → 잠금 · 401 · 다른 탭 전파 |
| `check-613` / `614` | 토큰 갱신 · 사용자 권한 관리 |
| `check-625` ~ `630` | 순찰 시작 · STOMP 제어 · 이벤트 상세 · 맵 좌표 · 설비 집계 |
| `check-cc` | 관제센터 전반 회귀 |

## 주의

- **포트가 겹치면 `EADDRINUSE` 로 죽는다.** 검증 스크립트는 각자 8099 를 띄우므로
  상주 백엔드(`serve-fake-backend`)를 끄고 돌리거나, 하나씩 순서대로 돌린다.
- 스크립트마다 CDP 포트가 다르다. 동시에 돌리면 충돌한다.
- `check-508` 은 유휴 15초로 띄운 인스턴스(`5175`)를 전제로 한다.
  `APP_URL=http://localhost:5175/` 로 지정하고, 그 서버는
  `VITE_SESSION_IDLE_MIN=0.25` 로 띄운다.
