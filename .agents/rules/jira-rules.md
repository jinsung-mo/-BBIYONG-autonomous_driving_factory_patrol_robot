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

## 4. Jira 티켓 구조 및 위계 (Epic ➔ Story / Task)

> ⚠️ **이 프로젝트 Jira 인스턴스의 실제 위계 (반드시 숙지)**
> 이 Jira는 **에픽(Epic)만 HierarchyLevel 1**이고, **스토리(Story)·작업(Task)·버그(Bug)는 모두 HierarchyLevel 0(동일 레벨, 형제 관계)** 입니다.
> 따라서 **Task의 `parent`(상위 업무) 필드에는 오직 Epic만 지정할 수 있으며, Story를 Task의 상위로 지정하는 것은 불가능**합니다(API가 `유효한 상위 업무를 선택하세요` 에러 반환). 별도의 커스텀 계층을 Jira 관리자가 추가하지 않는 한, "스토리 하위에 태스크" 구조는 만들 수 없습니다.

* **에픽 (Epic)**: 최상위 위계. 기존에 존재하는 에픽을 찾아 연결합니다.
* **스토리 (Story)**: 사용자 관점의 큰 서비스/기능 단위. `parent` 필드를 **상위 Epic**으로 설정합니다.
* **태스크 (Task)**: 1~2일 내 완료 가능한 상세 개발 단위. `parent` 필드를 **상위 Epic**으로 설정합니다. (Story가 아님)
* **Task ↔ Story 연관 방법**: Task를 논리적으로 특정 Story에 묶으려면 **이슈 링크(Issue Link, 타입 `Relates`)** 를 사용합니다. `parent = Story`는 절대 시도하지 않습니다.
  * (참고) 이슈 링크 생성: `POST {jira_url}/rest/api/2/issueLink` — `{"type":{"name":"Relates"},"inwardIssue":{"key":"태스크키"},"outwardIssue":{"key":"스토리키"}}`
* **스토리 그룹핑 유지**: Task는 여전히 논리적으로 하나의 Story에 속해야 합니다. 매핑할 Story가 없으면 **먼저 Story를 생성(parent = Epic)한 뒤, Task를 생성(parent = Epic)하고 그 Story에 `Relates` 링크로 연결**합니다.
* **하위 작업 (Sub-task) 사용 금지**: 복잡성을 방지하고 일관된 흐름을 유지하기 위해 Jira의 '하위 작업(Sub-task)' 티켓 타입은 절대로 사용하지 않습니다. 모든 하위 개발 항목은 개별 `Task` 타입으로 생성합니다.

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
