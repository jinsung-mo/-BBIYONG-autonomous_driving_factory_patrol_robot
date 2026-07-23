# CLAUDE.md - Project Conventions for Claude

## Project Context
This is the E101 BBIYONG (삐용) repository, containing FE, BE system, BE robot, and AI components.

## AI Assistant Rules & Conventions
When performing work in this repository, you MUST follow these specific conventions.

### 1. Jira Automation Conventions (Epic ➔ Story ➔ Task)
* **Structure**: Epic ➔ (Story | Task). **Do NOT use Jira Sub-tasks.**
* **⚠️ This Jira instance's real hierarchy**: Epic is HierarchyLevel 1; **Story, Task, and Bug are ALL HierarchyLevel 0 (siblings)**. Therefore a Task's `parent` field can ONLY point to an Epic — a Story **cannot** be the parent of a Task (the API rejects it with `유효한 상위 업무를 선택하세요`). The classic 3-tier "Story is parent of Task" model is NOT achievable here unless a Jira admin adds a custom hierarchy level.
* **Parenting rule**: Set the `parent` field of BOTH Story and Task to their **Epic**. To associate a Task with a Story, add an **issue link** of type `Relates` between them — never attempt `parent = Story`.
* **Mandatory Story grouping**: Every Task should still belong to a logical Story. If no matching Story exists when issuing a Task, first create the Story (parent = Epic), then create the Task (parent = Epic) and link it to that Story via a `Relates` issue link.
* **Title Format**: `[Type][Module] Summary` (e.g. `[Feat][BE] 회원가입 API 구현`, `[Fix][FE] 버튼 클릭 이벤트 미동작 수정`, `[Docs][BE] 관제 서버 API 명세서 작성`).
* **Story**: High-level domain features (e.g. `회원 관리`, `로봇 제어`).
* **Task**: Individual developer tasks of 1-2 days (e.g. `로그인 API 구현`).
* **Due Date**: Automatically set to the upcoming Friday.
* **Format**: All issue descriptions must strictly follow this template (emoticons removed):
  ```markdown
  1. **개요 (Context)**
     - ...
  2. **작업 상세 내용 (To-Do)**
     - ...
  3. **완료 기준 (Definition of Done)**
     - ...
  ```
* **Configuration**: Read `.ai_jira_config.json` or `.gemini_jira_config.json` in the root folder for URL, email, api token, and project key.

### 2. Git & Branching Conventions
* **Development Target Branches**: `fe/main`, `be_system/main`, `be_robot/main`, `ai/main`
* **Production Release Branch**: `main`
* **Branch Names**: `[prefix]/[JiraTicketId]-[task-name]` (e.g. `feat/S15P11E101-144-login`)
* **Commit Messages**: `[JiraTicketId] [prefix]: [Module] commit message` (e.g. `[S15P11E101-144] feat: [BE] 회원가입 API 구현`)
* **MR flow**: Always target the part main branch (e.g. `be_system/main`) rather than release `main`.
* **Mandatory MR Description Output**: Whenever pushing code or guiding MR creation, the AI agent MUST automatically generate and output a fully populated MR description markdown block (with Jira Ticket URL, Context, To-Do items, Definition of Done, and Reviewer Notes) in the final response.

For more details on team automation, refer to [AI.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/AI.md).
