# 삐용 (BBIYONG) - 통합 AI 협업 및 자동화 가이드 (AI, Cursor, Claude Code, Antigravity)

본 문서는 팀 E101 모두가 다양한 AI 어시스턴트(Gemini, Claude, GPT 등)와 AI 개발 도구(Antigravity, Cursor, Claude Code, Windsurf 등)를 활용하여 지라(Jira) 티켓 발급 및 깃(Git) 협업을 자동으로 수행할 수 있도록 규칙을 연동하는 가이드라인입니다.

---

## AI 협업 규칙 구성
어떤 AI 도구를 사용하더라도 일관성 있는 컨벤션을 유지할 수 있도록 핵심 규칙들이 분할되어 관리됩니다.

1. **Jira 자동화 규칙**: [jira-rules.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/.agents/rules/jira-rules.md)
   * Epic (lv2) ➔ Story (lv1) ➔ Task (lv0) 3단계 위계 준수 (Sub-task 사용 금지)
   * **스토리 없는 태스크 생성 금지**: Task(lv0) 생성 시 상위 Story(lv1)가 없으면 상위 Story를 먼저 생성한 후 연결
   * 제목 작성 시 `[유형][모듈] 작업 내용 요약` 형식 준수 (예: `[Feat][BE] 회원가입 API 구현`)
   * 티켓 생성 시 필수 속성 자동 매핑 (스토리 포인트, 기한, 우선순위, 레이블)
   * 티켓 본문(Description) 템플릿 강제 (이모티콘 미사용)
2. **Git 협업 규칙**: [git-rules.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/.agents/rules/git-rules.md)
   * 파트별 공통 메인 브랜치 설정 및 브랜치 명명 컨벤션
   * Jira 티켓 연동용 커밋 메시지 규칙 (예: `[S15P11E101-144] feat: [BE] 회원가입 API 구현`)
   * 실무 개발 및 최종 배포 머지 워크플로우

---

## 도구별 AI 규칙 자동 로드 설정

사용하시는 AI 개발 툴에 따라 규칙 파일이 자동으로 로드되도록 루트 경로에 심볼릭 링크나 규칙 파일을 연동해 두었습니다.

* **Google Antigravity (CLI `agy` & IDE)**:
  * 루트의 `AI.md` 및 `.agents/rules/` 폴더 내 규칙들을 자동으로 감지하여 에이전트 시스템 프롬프트에 주입합니다.
* **Cursor / Windsurf / VS Code AI Extensions**:
  * 루트 경로의 `.cursorrules` (또는 `.windsurfrules`) 설정 파일에 의해 동일한 AI 규칙이 자동 주입됩니다.
* **Claude Code (CLI tool by Anthropic)**:
  * 루트 경로의 `CLAUDE.md` 가이드라인 파일에 의해 Claude 어시스턴트가 프로젝트 컨벤션을 항상 확인하고 준수합니다.
* **ChatGPT / Custom GPTs / Web UI**:
  * 웹 브라우저에서 대화할 때는 이 [AI.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/AI.md) 파일 내용을 복사하여 프롬프트의 첫 문장으로 주입하거나 파일 첨부 기능을 이용해 AI에 제공해 주세요.

---

## MCP (Model Context Protocol) 및 스크립트 연동
AI 에이전트가 Jira API를 직접 제어할 수 있도록 **Jira MCP Server** 또는 **자동화 스크립트**를 구성해야 합니다.

### 1단계: 개인 Jira 토큰 설정
프로젝트 루트 폴더에 `.ai_jira_config.json` (또는 `.gemini_jira_config.json`) 파일을 생성하고 본인의 정보를 입력합니다.
*(이 파일은 `.gitignore`에 의해 로컬에만 유지되며 Git에 올라가지 않습니다.)*

```json
{
  "jira_url": "https://ssafy.atlassian.net",
  "jira_email": "your-email@example.com",
  "jira_api_token": "your-jira-api-token",
  "project_key": "S15P11E101"
}
```

### 2단계: 자동 MCP 설정 스크립트 실행
본인의 운영체제에 맞는 스크립트를 실행하면, 설정 파일의 크리덴셜을 읽어 글로벌 MCP 설정 파일(`mcp_config.json`)에 Jira 서버 연결 구성을 자동으로 인젝션합니다.

* **Windows 사용자 (PowerShell)**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\setup-mcp.ps1
  ```
  *(스크립트 링크: [setup-mcp.ps1](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/setup-mcp.ps1))*

* **macOS / Linux 사용자 (Bash)**:
  ```bash
  chmod +x setup-mcp.sh && ./setup-mcp.sh
  ```
  *(스크립트 링크: [setup-mcp.sh](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/setup-mcp.sh))*

---

## 개발 시 AI 지시 예시 (모든 AI 공통)
설정이 끝난 뒤 AI 어시스턴트(Gemini, Claude, GPT 등)에게 다음과 같이 자연어로 지시하면 규칙에 맞춰 정확하게 작업을 수행합니다:

* **Jira 티켓 발행 지시**:
  > *"회원관리 기능 개발을 위한 지라 티켓 설계하고 자동 생성해줘."*
  > * AI는 자동으로 [jira-rules.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/.agents/rules/jira-rules.md)를 참고해 Epic (lv2) ➔ Story (lv1) ➔ Task (lv0) 구조로 설계하며, 상위 스토리가 없는 경우 스토리를 먼저 생성한 후 Task를 연결하여 Jira API로 발행합니다. (예: `[Feat][BE] 회원가입 API 구현` 제목 형식과 이모티콘 없는 본문 템플릿 사용)
* **Git 협업 및 커밋 지시**:
  > *"이번 작업 완료했어. 지라 연동 규칙에 맞춰 브랜치 따고, 커밋 작성한 뒤 내 파트 메인 브랜치로 MR 올려줘."*
  > * AI는 [git-rules.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/.agents/rules/git-rules.md)에 따라 `[S15P11E101-144] feat: [BE] 회원가입 API 구현` 형태의 커밋 메시지와 `feat/S15P11E101-144-login` 브랜치를 생성한 뒤, `be_system/main` 등 알맞은 타겟 브랜치로 병합 요청을 보냅니다.
