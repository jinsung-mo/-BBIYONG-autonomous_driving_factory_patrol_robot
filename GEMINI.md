# GEMINI.md - Project Conventions for Google Gemini

This repository (E101 BBIYONG / 삐용) follows strict automation rules for Jira ticketing, Git branching, and system architecture. When performing tasks in this repository with Google Gemini, you MUST adhere to the following rules.

---

## Project Context
This is the E101 BBIYONG (삐용) repository, containing FE, BE system, BE robot, and AI components.

---

## 1. Jira Automation Conventions (Epic ➔ Story ➔ Task)

### Hierarchy Structure
* **Structure**: `Epic ➔ Story ➔ Task` 3-tier hierarchy. **Do NOT use Jira Sub-tasks.**
  * **Epic**: Top-level domain epic (already created, no new Epics will be added)
  * **Story**: Feature-level story as a child of Epic
  * **Task**: Individual developer task (1-2 days) linked to Story via "Relates to" relationship

### Parenting Rules
* Story's `parent` = Epic (parent-child relationship)
* Task is linked to Story via **"Relates to"** issue link (NOT parent-child)
* **Mandatory Story grouping**: Every Task must be associated with a Story via "Relates to" link
  - If no matching Story exists when creating a Task, first create the Story (as child of Epic)
  - Then create the Task and link it to the Story via "Relates to" issue link

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
* **Branch Cleanup Rule**: After MR is merged, always delete the feature branch locally (`git branch -D [branch-name]`) and remotely (GitLab UI or `git push origin --delete [branch-name]`)

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
