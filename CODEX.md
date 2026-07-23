# CODEX.md - Project Conventions for OpenAI Codex & Copilot

This repository (E101 BBIYONG / 삐용) follows strict automation rules for Jira ticketing, Git branching, and system architecture. When performing tasks in this repository with OpenAI Codex or GitHub Copilot, you MUST adhere to the following rules.

---

## 1. Jira Automation Conventions (Epic ➔ Story ➔ Task 3-Tier Hierarchy)

* **Structure**: `Epic ➔ Story ➔ Task` 3-tier hierarchy.
  * **Epic**: Top-level domain epic (already created, no new Epics will be added).
  * **Story**: Feature-level domain story as a child of Epic (Story's `parent` = Epic).
  * **Task**: Individual developer task (1-2 days) linked to Story via "Relates to" relationship (NOT parent-child).
  * **Do NOT use Jira Sub-tasks.**
* **Title Format**: `[Type][Module] Summary` (e.g. `[Feat][BE] Spring Boot WSS 핸들러 구현`, `[Fix][FE] 대시보드 소켓 오류 수정`).
* **Due Date**: Set to upcoming Friday of current week for Story & Task. Epic dates are already set (no new Epics will be created).
* **Assignee**: Automatically set to current user (`accountId` fetched from `GET /rest/api/2/myself`).
* **Description Template**:
  ```markdown
  1. **개요 (Context)**
     - (이 작업을 진행하게 된 배경이나 목적을 1~2줄로 서술합니다.)

  2. **작업 상세 내용 (To-Do)**
     - (구체적인 작업 항목 목록)

  3. **완료 기준 (Definition of Done)**
     - (해당 티켓 완료를 검증할 수 있는 테스트 및 확인 조건)
  ```
* **Configuration**: Read `.ai_jira_config.json` or `.gemini_jira_config.json` in the root directory for Jira URL, email, API token, and project key.

---

## 2. Git & Branching Conventions

* **Hierarchy**: `main` (Production Release) ➔ `fe/main`, `be_system/main`, `be_robot/main`, `ai/main` (Part Mains) ➔ `fe/dev`, `be_system/dev`, `be_robot/dev`, `ai/dev` (Part Devs) ➔ `feat/S15P11E101-XXX-name` (Feature Branches).
* **Branch Name Format**: `[prefix]/[JiraTicketId]-[task-name]` (e.g. `feat/S15P11E101-281-wss-handler`)
* **Commit Message Format**: `[JiraTicketId] [prefix]: [Module] commit message` (e.g. `[S15P11E101-281] feat: [BE] Spring Boot WSS 핸들러 구현`)
* **MR Flow**: Target part dev branch (e.g. `be_system/dev`) for feature branches, then merge part dev to part main (`be_system/main`), then merge part main to `main` for release.
* **Branch Cleanup Rule**: After MR is merged, always delete the feature branch locally (`git branch -D [branch-name]`) and remotely (GitLab UI or `git push origin --delete [branch-name]`).
* **Mandatory MR Description Output**: Whenever pushing code or guiding MR creation, the AI agent MUST automatically generate and output a fully populated MR description markdown block (with Jira Ticket URL, Context, To-Do items, Definition of Done, and Reviewer Notes, WITHOUT checkboxes) in the final response.

---

## 3. Communication Protocols & System Architecture

* **Robot ↔ Backend Communication**: **WSS (WebSocket Secure)** over Nginx 443 Port (`wss://<domain>/ws/robot`).
* **Backend ↔ Web Client Communication**: **WebSocket (STOMP)** over Nginx 443 Port (`wss://<domain>/ws-관제`).
* **REST APIs**: `/api/*` routed via Nginx 443 Port to Spring Boot (`:8080`).

For more details on team automation, refer to [AI.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/AI.md) and [architecture_and_api_spec.md](file:///C:/Users/SSAFY/Desktop/PRODUCE_E101/S15P11E101/docs/architecture_and_api_spec.md).
