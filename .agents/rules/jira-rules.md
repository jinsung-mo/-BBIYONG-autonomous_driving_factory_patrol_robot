# Jira 자동화 규칙 (Jira Automation Rules)

이 프로젝트에서는 지라(Jira) 티켓 생성 및 관리를 요청받았을 때 아래 규칙을 무조건 준수하여 자동으로 처리합니다.

## 1. 지라(Jira) 크리덴셜 자동 로드
* 지라 관련 작업을 시작하기 전에 프로젝트 루트 경로의 `.ai_jira_config.json` 또는 `.gemini_jira_config.json` 파일을 가장 먼저 읽습니다.
* 해당 파일에서 `jira_url`, `jira_email`, `jira_api_token`, `project_key` 정보를 파악합니다.
* 사용자가 매번 로그인 정보나 토큰을 물어보지 않아도 이 파일의 정보로 자동으로 인증을 처리합니다.

## 2. API 호출을 통한 자동 티켓 생성
* 사용자가 지라 티켓 발급을 원하면 프로젝트 내의 `create_jira_tickets.py` 스크립트를 실행하거나, 직접 Jira REST API(`POST {jira_url}/rest/api/2/issue`)를 통해 티켓을 발급합니다.
* 발급 성공 시 생성된 티켓 키(예: `S15P11E101-12`)를 사용자에게 응답해 줍니다.

## 3. 티켓 생성 시 필수 속성 자동 생성 및 매핑
티켓을 생성할 때 기본 정보(제목, 설명) 외에 아래의 4가지 속성을 반드시 자동으로 구성하여 함께 API로 전달합니다.

1. **스토리 포인트 (Story Points)**: 
   * Jira Cloud에서 스토리 포인트는 `customfield_XXXXX` 형태의 동적 커스텀 필드 ID를 사용합니다.
   * API 호출 전 `GET {jira_url}/rest/api/2/field`를 호출하여 이름(name)이 `"Story Points"` 또는 `"스토리 포인트"`인 필드를 찾아 해당 필드의 `id`에 스토리 포인트 값을 매핑해야 합니다.
2. **업무 순위 (Priority)**: 
   * 중요도에 따라 `"priority": {"name": "Highest" | "High" | "Medium" | "Low" | "Lowest"}` 형태로 설정합니다.
3. **기한 (Due Date)**: 
   * 기한은 항상 해당 주 금요일(금요일이 지난 주말인 경우 다음 주 금요일)로 마감일(`"duedate": "YYYY-MM-DD"`)을 자동 계산하여 설정합니다.
4. **레이블 (Labels)**: 
   * 파트(예: `FE`, `BE`, `AI`, `Chore`, `Feature` 등)에 맞는 태그들을 `"labels": ["FE", "Chore"]` 형태의 문자열 리스트로 매핑합니다.

## 4. Jira 티켓 구조 및 위계 (Epic ➔ Story ➔ Task 3단계 구조)
* 지라 티켓 설계 및 생성 시 **`Epic ➔ Story ➔ Task`**의 3단계 위계를 철저히 준수합니다.
* **에픽 (Epic)**: 프로젝트 최상위 도메인 에픽으로, 스토리를 상위에 연결합니다.
* **스토리 (Story)**: 사용자 관점의 큰 서비스/기능 단위로 작성하며, 상위 **에픽(Epic)**에 연결합니다. (예: `[Feat][BE] Nginx 443 WSS 통신 기반 로봇-서버 실시간 제어 구축`)
* **태스크 (Task)**: 스토리를 완료하기 위한 1~2일 단위 개발 작업으로 작성하며, 반드시 상위 **스토리(Story)**와 연동(IssueLink/Parent)합니다. (예: `[Feat][BE] Spring Boot RobotWebSocketHandler 구현`)
* **하위 작업 (Sub-task) 사용 금지**: Jira 고유의 Sub-task 티켓 타입은 사용하지 않으며, 모든 개발 작업은 상위 스토리(Story)와 연결된 개별 `Task` 타입으로 생성합니다.

## 5. Jira 티켓 제목(Summary) 규칙
* 모든 작업 티켓의 제목은 **`[유형][모듈] 작업 내용 요약`** 형식(가장 권장)으로 작성합니다.
* 유형: `Feat`, `Fix`, `Docs`, `Design`, `Refactor`, `Chore`, `Test` 등
* 모듈: `FE`, `BE`, `AI`, `Robot`, `System`, `Docs` 등
* *작성 예시*:
  * `[Feat][BE] 회원가입 API 구현`
  * `[Fix][FE] 버튼 클릭 이벤트 미동작 수정`
  * `[Docs][BE] 관제 서버 API 명세서 작성`

## 6. 티켓 본문(Description) 템플릿 준수 규칙
모든 티켓의 본문(Description)은 반드시 아래의 마크다운 템플릿 형식(이모티콘 제외)을 완벽하게 지켜서 작성해야 합니다.

```markdown
1. **개요 (Context)**
   - (이 작업을 진행하게 된 배경이나 목적을 1~2줄로 서술합니다.)

2. **작업 상세 내용 (To-Do)**
   - (구체적인 작업 항목 목록)

3. **완료 기준 (Definition of Done)**
   - (해당 티켓 완료를 검증할 수 있는 테스트 및 확인 조건)
```

## 7. 보안 준수
* `.ai_jira_config.json` 및 `.gemini_jira_config.json` 파일은 반드시 `.gitignore`에 추가되어 깃 저장소에 커밋/푸시되지 않도록 감시합니다.
