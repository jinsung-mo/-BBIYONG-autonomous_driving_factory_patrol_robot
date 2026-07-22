# Git 협업 규칙 (Git Collaboration Rules)

이 프로젝트에서는 브랜치 생성, 커밋 메시지 작성 및 머지 요청 시 아래 규칙을 무조건 준수하여 자동으로 처리합니다.

## 1. 브랜치 명명 컨벤션 및 파트별 dev/main 위계 구조
팀 E101은 파트별 독립 개발 및 체계적인 버전 관리를 위해 **`main ➔ 파트별 main ➔ 파트별 dev ➔ 기능 개발 브랜치`**의 4단계 구조를 사용합니다.

* **최상위 정식 배포 메인 브랜치 (`main`)**: 프로젝트 최종 정식 배포 및 프로덕션 릴리스 전용 브랜치 (보호됨)
* **파트별 메인 브랜치 (Part Main)**:
  * `fe/main` (프론트엔드 파트 메인)
  * `be_system/main` (시스템 백엔드 파트 메인)
  * `be_robot/main` (로봇 백엔드 파트 메인)
  * `ai/main` (AI 파트 메인)
* **파트별 통합 개발 브랜치 (Part Dev - Version Control)**:
  * `fe/dev` (프론트엔드 파트 개발 및 버전 통합)
  * `be_system/dev` (시스템 백엔드 파트 개발 및 버전 통합)
  * `be_robot/dev` (로봇 파트 개발 및 버전 통합)
  * `ai/dev` (AI 파트 개발 및 버전 통합)
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

## 3. 실무 개발 및 단계별 머지(Merge) 워크플로우
1. **로컬 작업 시작**: 본인 파트의 통합 개발 브랜치(`be_system/dev` 등)를 최신화한 후 기능 브랜치를 분기합니다.
   ```bash
   git checkout be_system/dev
   git pull origin be_system/dev
   git checkout -b feat/S15P11E101-144-login
   ```
2. **파트 dev 머지 (1단계 MR - 기능 완료)**:
   - Source: `feat/S15P11E101-144-login` ➔ Target: **`be_system/dev`** (파트 통합 개발 브랜치)
3. **파트 main 머지 (2단계 MR - 파트 버전 확정)**:
   - 파트원들의 기능들이 `be_system/dev`에 모이면 리뷰 후 **`be_system/main`**으로 병합하여 안정화 버전을 확정합니다.
4. **최종 정식 배포 (3단계 MR - Release)**:
   - 각 파트의 `*/main` 브랜치들을 최상위 **`main`** 브랜치로 최종 병합하여 정식 릴리스합니다.

## 4. 작업 완료 후 브랜치 자동 정리 규칙 (Branch Cleanup Rule)
* **MR 머지 시 원격 브랜치 삭제**: GitLab MR 생성 시 *"Delete source branch when merge request is accepted"* 옵션을 기본 체크하여 병합 성공 즉시 원격 임시 브랜치를 자동 삭제합니다.
* **푸시/머지 완료 후 로컬 브랜치 삭제**: 푸시 및 MR 생성을 완료하고 파트 메인 브랜치(`be_system/main` 등)로 복귀한 후, 사용을 마친 로컬 임시 브랜치는 `git branch -D [branch-name]` 명령어로 자동 삭제하고 `git fetch -p`를 수행하여 로컬/원격 브랜치 목록을 항상 깨끗하게 유지합니다.

## 4. GitLab Merge Request 본문 관련 티켓 자동화 (Jira Link Auto-Fill)
* AI 에이전트는 사용자를 도와 GitLab Merge Request(MR)의 본문을 작성하거나 스크립트를 빌드할 때, **현재 작업 중인 Git 브랜치명**에서 지라 티켓 번호(예: `S15P11E101-144`)를 자동으로 추출해야 합니다.
* 추출한 티켓 번호를 이용하여 지라 링크(`[S15P11E101-144](https://ssafy.atlassian.net/browse/S15P11E101-144)`)를 조립한 뒤, MR 본문 템플릿의 **`### 관련 Jira 티켓`** 섹션 바로 아래에 자동으로 채워 넣어야 합니다.
