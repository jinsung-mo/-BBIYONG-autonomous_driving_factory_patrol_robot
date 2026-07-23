# CLAUDE.md - Project Conventions for Claude

## Project Context
This is the E101 BBIYONG (삐용) repository, containing FE, BE system, BE robot, and AI components.

## AI Assistant Rules & Conventions
When performing work in this repository, you MUST follow these specific conventions.

### 1. Jira Automation Conventions (Epic ➔ Story ➔ Task)
* **Structure**: Epic ➔ Story ➔ Task. **Do NOT use Jira Sub-tasks.**
* **Title Format**: `[Type][Module] Summary` (e.g. `[Feat][BE] 회원가입 API 구현`, `[Fix][FE] 버튼 클릭 이벤트 미동작 수정`, `[Docs][BE] 관제 서버 API 명세서 작성`).
* **Story**: High-level domain features (e.g. `회원 관리`, `로봇 제어`).
* **Task**: Individual developer tasks of 1-2 days (e.g. `로그인 API 구현`).
* **Due Date**: Automatically set to the upcoming Friday.
* **Assignee**: Automatically search for user's `accountId` using their configuration email, and assign all created issues to them.
* **Format**: All issue descriptions must strictly follow this template (emoticons removed). Use asterisks (*) for checkbox lists to prevent rendering bugs:
  ```markdown
  ### 개요 (Context)
  - 
  ### 작업 상세 내용 (To-Do)
  - 
  ### 완료 기준 (Definition of Done)
  - 
  ```
  (Note: When programmatically using Jira REST API v2, convert '### ' headers to 'h3. ' and '- ' to '* ' to avoid rendering bugs where '#' is parsed as numbered list items 1. a. i.)
* **Configuration**: Read `.ai_jira_config.json` or `.gemini_jira_config.json` in the root folder for URL, email, api token, and project key.

### 2. Git & Branching Conventions
* **Development Target Branches**: `fe/main`, `be_system/main`, `be_robot/main`, `ai/main`
* **Production Release Branch**: `main`
* **Branch Names**: `[prefix]/[JiraTicketId]-[task-name]` (e.g. `feat/S15P11E101-144-login`)
* **Commit Messages**: `[JiraTicketId] [prefix]: [Module] commit message` (e.g. `[S15P11E101-144] feat: [BE] 회원가입 API 구현`)
* **MR flow**: Always target the part main branch (e.g. `be_system/main`) rather than release `main`.
* **MR Auto-Fill**: Extract the Jira Issue Key (e.g. `S15P11E101-144`) from the active branch name, format it as a link `[S15P11E101-144](https://ssafy.atlassian.net/browse/S15P11E101-144)`, and write it under `### 관련 Jira 티켓` when assisting the user with GitLab MR creation.

For more details on team automation, refer to [AI.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/AI.md).

### 3. Ticket-First Workflow Automation (No Ticket, No Work)
* Before writing any code, modifying files, or creating branches for a task, you MUST automatically create the Jira ticket via API first.
* Report the ticket key to the user, then checkout the branch `[prefix]/[JiraTicketId]-[task-name]`, and finally perform the coding/writing. Do not code without a ticket key.
