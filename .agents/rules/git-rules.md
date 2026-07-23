# Git 협업 규칙 (Git Collaboration Rules)

이 프로젝트에서는 브랜치 생성, 커밋 메시지 작성 및 머지 요청 시 아래 규칙을 무조건 준수하여 자동으로 처리합니다.

## 1. 브랜치 명명 컨벤션 (Branch Name)
* **파트별 공통 메인 브랜치 (보호됨)**: 
  * `fe/main` (프론트엔드)
  * `be_system/main` (시스템 백엔드)
  * `be_robot/main` (로봇 백엔드)
  * `ai/main` (AI 파트)
  * `main` (통합 배포 메인 브랜치)
* **기능 개발 브랜치 생성 규칙**: `[접두사]/[Jira티켓번호]-[간단한작업명]`
  * *예시*: **`feat/S15P11E101-144-login`**, **`fix/S15P11E101-145-socket-error`**

## 2. 커밋 메시지 컨벤션 (Commit Message)
* **메시지 작성 규칙**: `[Jira티켓번호] 접두사: 커밋 메시지 내용`
  * 대괄호 `[Jira티켓번호]`를 맨 앞에 정확히 적어야 지라 티켓에 해당 커밋 코드가 자동으로 기록됩니다.
  * 커밋 메시지는 연동된 Jira 티켓 제목의 `[유형][모듈] 작업 내용` 흐름과 통일감을 갖추어 작성합니다.
  * *예시*: **`[S15P11E101-144] feat: [BE] 회원가입 API 구현`**

### 2.1 주요 접두사(Prefix) 정의
* **`feat`** or **`feature`**: 새로운 기능 구현 및 개발
* **`fix`** or **`bug`**: 오동작 수정 및 버그 픽스
* **`docs`**: 문서 작성 및 수정 (기획서, 명세서, README 등)
* **`design`**: UI/UX 디자인 및 화면 퍼블리싱 작업
* **`refactor`**: 코드 가독성 개선, 성능 최적화 등 구조 개선 (기능 변화 없음)
* **`chore`**: 의존성 라이브러리 추가, 빌드 설정 및 단순 인프라 설정 수정
* **`test`**: 테스트 코드 작성 및 기능 검증 작업

## 3. 실무 개발 및 머지(Merge) 워크플로우
* **로컬 작업 시작**: 반드시 본인 파트의 공통 메인 브랜치를 최신화한 후 분기합니다.
  ```bash
  git checkout be_system/main
  git pull origin be_system/main
  git checkout -b feat/S15P11E101-144-login
  ```
* **Merge Request (Target 브랜치 주의)**:
  - Source: `feat/S15P11E101-144-login`
  - Target: **`be_system/main`** (최종 `main`이 아닌, 본인 파트의 브랜치로 머지합니다!)
  - 웹페이지에 연동된 템플릿의 체크리스트를 채우고 파트원 승인을 얻어 병합합니다.
* **최종 배포 통합**: 스프린트가 끝나거나 배포 시점에 각 파트의 `*/main` 브랜치들을 최종 상위 브랜치인 **`main`** 브랜치로 최종 병합합니다.

## 4. 작업 완료 후 브랜치 자동 정리 규칙 (Branch Cleanup Rule)
* **MR 머지 시 원격 브랜치 삭제**: GitLab MR 생성 시 *"Delete source branch when merge request is accepted"* 옵션을 기본 체크하여 병합 성공 즉시 원격 임시 브랜치를 자동 삭제합니다.
* **푸시/머지 완료 후 로컬 브랜치 삭제**: 푸시 및 MR 생성을 완료하고 파트 메인 브랜치(`be_system/main` 등)로 복귀한 후, 사용을 마친 로컬 임시 브랜치는 `git branch -D [branch-name]` 명령어로 자동 삭제하고 `git fetch -p`를 수행하여 로컬/원격 브랜치 목록을 항상 깨끗하게 유지합니다.

## 5. AI 에이전트의 MR 본문 자동 생성 및 출력 의무 (Mandatory MR Description Output)
* **자동 생성 의무**: AI 에이전트는 코드 푸시(Push) 및 MR 생성 안내 시, 사용자가 GitLab에 바로 복사-붙여넣기할 수 있는 완벽히 채워진 MR 본문 마크다운 코드 블록을 **반드시 최종 응답에 포함하여 출력**해야 합니다.
* **MR 본문 자동 조립 항목**:
  1. **관련 Jira 티켓**: 현재 브랜치명에서 Jira 티켓 번호(예: `S15P11E101-282`)를 자동 추출하여 클릭 가능한 지라 URL 링크 생성 (`- [S15P11E101-282](https://ssafy.atlassian.net/browse/S15P11E101-282)`)
  2. **개요 (Context)**: 이번 작업의 배경 및 목적 요약
  3. **작업 상세 내용 (To-Do)**: 실제 구현된 소스 코드 변경점 및 파일 목록 체크리스트 (`- [x] ...`)
  4. **완료 기준 및 테스트 결과 (Definition of Done)**: 성공한 빌드 및 테스트 결과 요약 (`- [x] ...`)
  5. **리뷰어에게 전달할 특이사항**: 파트원 코드 리뷰 시 주의 깊게 봐야 할 포인트 기술

## 6. 버저닝 및 Git Tag 규칙 (Version Tagging)
* **방식**: 버전은 **Git Tag(SemVer `vMAJOR.MINOR.PATCH`)** 로 간단하게 관리합니다. 릴리스 시점에 `scripts/auto_tagger.py` 를 **수동 실행**하면 다음 버전을 자동 계산·태깅·푸시해 줍니다. (별도 CI/스케줄러 불필요)
* **버전 단계 정의**:
  * **PATCH (마지막 버전)** — 자잘한 수정 단위: `--type patch` (`v1.2.0` ➔ `v1.2.1`)
  * **MINOR (중간 버전)** — 기능 묶음 완성/일 단위: `--type minor` (`v1.2.3` ➔ `v1.3.0`)
  * **MAJOR (최종 버전)** — main 릴리스 병합: `--type major` (`v1.3.0` ➔ `v2.0.0`, 브랜치=main 이면 auto 로도 감지)
* **변경 없음 처리**: 최신 태그 이후 **새 커밋이 없으면 태그를 만들지 않고 건너뜁니다**(빈 버전 방지). 며칠간 업데이트가 없으면 그냥 skip 되고, 새 커밋 후 실행할 때 태그가 찍힙니다. (강제 태깅은 `--force`)
* **실행 예시**:
  * 미리보기: `python scripts/auto_tagger.py --dry-run`
  * 태깅: `python scripts/auto_tagger.py --type patch|minor|major`
  * 스크립트 없이 직접: `git tag -a v1.2.0 -m "메시지" && git push origin v1.2.0`
* **(선택) CI 자동화**: 필요해지면 커밋 push→`--type patch`, 일일 스케줄→`--type minor`, main 병합→`--type major` 로 파이프라인에 연결할 수 있습니다. **필수는 아닙니다.**
