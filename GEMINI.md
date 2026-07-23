# GEMINI.md - Project Conventions for Google Gemini

This repository (E101 BBIYONG / 삐용) follows strict automation rules for Jira ticketing, Git branching, and system architecture. When performing tasks in this repository with Google Gemini, you MUST adhere to the following rules.

---

## Project Context
This is the E101 BBIYONG (삐용) repository, containing FE, BE system, BE robot, and AI components.

---

## 1. Jira Automation Conventions (Epic ➔ Story ➔ Task)

### Hierarchy Structure
* **Structure**: Epic ➔ (Story | Task). **Do NOT use Jira Sub-tasks.**
* **⚠️ Important**: In this Jira instance, Epic is HierarchyLevel 1; **Story, Task, and Bug are ALL HierarchyLevel 0 (siblings)**
  - A Task's `parent` field can ONLY point to an Epic, NOT a Story
  - The API rejects `parent = Story` with error `유효한 상위 업무를 선택하세요`

### Parenting Rules
* Set the `parent` field of BOTH Story and Task to their **Epic**
* To associate a Task with a Story, add an **issue link** of type `Relates` between them (never use `parent = Story`)
* **Mandatory Story grouping**: Every Task should still belong to a logical Story
  - If no matching Story exists when creating a Task, first create the Story (parent = Epic)
  - Then create the Task (parent = Epic) and link it to that Story via a `Relates` issue link

### Ticket Format
* **Title Format**: `[Type][Module] Summary`
  - Examples:
    - `[Feat][BE] 회원가입 API 구현`
    - `[Fix][FE] 버튼 클릭 이벤트 미동작 수정`
    - `[Docs][BE] 관제 서버 API 명세서 작성`
* **Story**: High-level domain features (e.g., `회원 관리`, `로봇 제어`)
* **Task**: Individual developer tasks of 1-2 days (e.g., `로그인 API 구현`)
* **Due Date**: Automatically set to the upcoming Friday

### Issue Description Template
All issue descriptions must strictly follow this template (emoticons removed):
```markdown
1. **개요 (Context)**
   - ...
2. **작업 상세 내용 (To-Do)**
   - ...
3. **완료 기준 (Definition of Done)**
   - ...
```

### Configuration
Read `.ai_jira_config.json` or `.gemini_jira_config.json` in the root folder for Jira URL, email, API token, and project key.

---

## 2. Git & Branching Conventions

### Branch Structure
* **Development Target Branches**: `fe/main`, `be_system/main`, `be_robot/main`, `ai/main`
* **Production Release Branch**: `main`

### Naming Conventions
* **Branch Names**: `[prefix]/[JiraTicketId]-[task-name]`
  - Example: `feat/S15P11E101-144-login`
* **Commit Messages**: `[JiraTicketId] [prefix]: [Module] commit message`
  - Example: `[S15P11E101-144] feat: [BE] 회원가입 API 구현`

### Merge Request Flow
* Always target the part-specific main branch (e.g., `be_system/main`) when submitting Merge Requests
* **Never target the production `main` branch directly**

### Mandatory MR Description Output
Whenever pushing code or guiding MR creation, you MUST automatically generate and output a fully populated MR description markdown block with:
- Jira Ticket URL
- Context (개요)
- To-Do items (작업 상세 내용)
- Definition of Done (완료 기준)
- Reviewer Notes

**MR Description Format**:
```markdown
## 관련 Jira 티켓
[S15P11E101-XXX](https://ssafy.atlassian.net/browse/S15P11E101-XXX)

## 개요 (Context)
- ...

## 작업 상세 내용 (To-Do)
- [ ] ...
- [ ] ...

## 완료 기준 (Definition of Done)
- [ ] ...
- [ ] ...

## Reviewer Notes
- ...

🤖 Generated with Google Gemini

Co-Authored-By: Gemini <noreply@google.com>
```

---

## 3. Ticket-First Workflow (No Ticket, No Work)

**IMPORTANT**: Before writing any code, you MUST:
1. Create a corresponding Jira ticket via API
2. Report issue key to user
3. Create local branch `[prefix]/[JiraTicketId]-[task-name]`
4. Start coding

**Never modify code without a ticket ID!**

---

## 4. Communication Protocols & System Architecture

* **Robot ↔ Backend Communication**: **WSS (WebSocket Secure)** over Nginx 443 Port (`wss://<domain>/ws/robot`)
* **Backend ↔ Web Client Communication**: **WebSocket (STOMP)** over Nginx 443 Port (`wss://<domain>/ws-관제`)
* **REST APIs**: `/api/*` routed via Nginx 443 Port to Spring Boot (`:8080`)

---

## Additional Resources
- Full conventions for other AI tools:
  - Claude: `CLAUDE.md`
  - Cursor/Windsurf: `.cursorrules`
  - GitHub Copilot/Codex: `CODEX.md`
- Team automation details: `AI.md`
- Architecture: `docs/architecture_and_api_spec.md`

---

**Important Notes for Gemini**:
- Always use the `.gemini_jira_config.json` for Jira API configuration
- Follow the exact Jira hierarchy rules (Epic → Story/Task, NOT Story → Task)
- Generate MR descriptions in Korean with the exact format above
- Include "Generated with Google Gemini" attribution in MR descriptions
