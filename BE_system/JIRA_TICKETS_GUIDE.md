# Jira 티켓 자동 생성 가이드 - 백엔드 품질 개선

## 🎫 티켓 구조 (팀 E101 컨벤션)

```
📦 Epic: [Feat][BE] 백엔드 품질 및 운영성 개선 (SP: 8)
│
├── 📖 Story 1: API 문서화 및 개발 경험 개선 (SP: 5)
│   └── ✅ Task: [Feat][BE] Swagger/OpenAPI 3.0 API 문서 자동화 (SP: 3)
│       ├── Branch: feat/backend-quality-improvements
│       ├── Commit: cb8f2a0
│       └── Status: 완료
│
└── 📖 Story 2: 운영 모니터링 및 안정성 강화 (SP: 3)
    └── ✅ Task: [Feat][BE] Health Check & Metrics 모니터링 강화 (SP: 2)
        ├── Branch: feat/backend-quality-improvements
        ├── Commit: 95d59e2
        └── Status: 완료
```

**주요 특징** (CLAUDE.md, AI.md 준수):
- ⚠️ **Task의 parent는 Epic** (Story가 아님 - Jira 제약사항)
- 🔗 **Task ↔ Story는 "Relates" 이슈 링크**로 연결
- 📅 **Due Date**: 자동으로 다음 금요일로 설정
- 🏷️ **Labels**: BE, Documentation, Monitoring 등
- 📊 **Story Points**: Epic 8, Story 5/3, Task 3/2

---

## 🚀 자동 생성 방법

### 1단계: Jira 설정 파일 생성

프로젝트 **루트 디렉토리**에 `.ai_jira_config.json` 생성:

```json
{
  "jira_url": "https://ssafy.atlassian.net",
  "jira_email": "your-email@ssafy.com",
  "jira_api_token": "your-api-token-here",
  "project_key": "S15P11E101"
}
```

**Jira API 토큰 발급**:
1. https://id.atlassian.com/manage-profile/security/api-tokens 접속
2. "Create API token" 클릭
3. 토큰 이름: "AI Automation"
4. 생성된 토큰 복사 후 위 JSON에 붙여넣기

### 2단계: Python 스크립트 실행

```bash
cd BE_system
python3 create_jira_tickets.py
```

**예상 출력**:
```
============================================================
Jira 티켓 자동 생성 - 백엔드 품질 개선 (팀 E101 컨벤션)
============================================================

📌 Jira: https://ssafy.atlassian.net
📌 프로젝트: S15P11E101

✅ Epic 생성: S15P11E101-XXX - [Feat][BE] 백엔드 품질 및 운영성 개선

✅ Story 생성: S15P11E101-XXX - API 문서화 및 개발 경험 개선
✅ Task 생성: S15P11E101-XXX - [Feat][BE] Swagger/OpenAPI 3.0 API 문서 자동화
   🔗 링크: S15P11E101-XXX ↔ S15P11E101-XXX

✅ Story 생성: S15P11E101-XXX - 운영 모니터링 및 안정성 강화
✅ Task 생성: S15P11E101-XXX - [Feat][BE] Health Check & Metrics 모니터링 강화
   🔗 링크: S15P11E101-XXX ↔ S15P11E101-XXX

============================================================
✨ Jira 티켓 생성 완료!

🔗 Epic: https://ssafy.atlassian.net/browse/S15P11E101-XXX
🔗 Task 1: https://ssafy.atlassian.net/browse/S15P11E101-XXX
🔗 Task 2: https://ssafy.atlassian.net/browse/S15P11E101-XXX
```

---

## 📋 티켓 상세 내용

### Epic: [Feat][BE] 백엔드 품질 및 운영성 개선

**본문**:
```
1. **개요 (Context)**
   - 백엔드 시스템의 개발 생산성, 운영 안정성, 코드 품질을 전반적으로 향상
   - API 문서 자동화와 모니터링 강화를 통해 실무 운영 환경 대비

2. **작업 상세 내용 (To-Do)**
   - Swagger/OpenAPI를 활용한 API 문서 자동화
   - Actuator 기반 헬스체크 및 메트릭 모니터링 강화
   - 로봇 연결 상태 및 WebSocket 세션 실시간 추적

3. **완료 기준 (Definition of Done)**
   - 모든 하위 Story 및 Task 완료
   - Swagger UI와 Actuator 엔드포인트 정상 동작
   - 운영 환경 배포 및 모니터링 가능
```

---

### Story 1: API 문서화 및 개발 경험 개선

**본문**:
```
1. **개요 (Context)**
   - API 문서를 마크다운에서 자동 생성되는 Swagger UI로 전환하여 문서-코드 불일치 제거
   - 프론트엔드 개발자가 실시간으로 API 테스트 가능하도록 개발 경험 향상

2. **작업 상세 내용 (To-Do)**
   - SpringDoc OpenAPI 3.0 의존성 추가 및 설정
   - 주요 Controller에 OpenAPI 어노테이션 추가
   - JWT Bearer Token 인증 스킴 설정
   - Swagger UI 접근 권한 설정

3. **완료 기준 (Definition of Done)**
   - Swagger UI 접속 가능 (http://localhost:8080/swagger-ui.html)
   - 주요 REST API 문서화 완료
   - JWT 토큰으로 인증 API 테스트 가능
```

---

### Task 1: [Feat][BE] Swagger/OpenAPI 3.0 API 문서 자동화

**본문**:
```
1. **개요 (Context)**
   - SpringDoc OpenAPI를 사용하여 REST API 문서를 자동 생성하고 Swagger UI 제공
   - 프론트엔드 개발자가 브라우저에서 직접 API 테스트 가능

2. **작업 상세 내용 (To-Do)**
   - build.gradle에 SpringDoc OpenAPI 의존성 추가
   - OpenApiConfig 설정 클래스 작성 (API 메타데이터, JWT 보안 스킴)
   - SecurityConfig에 Swagger UI 접근 허용 경로 추가
   - AuthController, RobotController, EventController에 @Tag, @Operation 어노테이션 추가
   - application.properties에 SpringDoc 설정 추가

3. **완료 기준 (Definition of Done)**
   - /swagger-ui.html 접속 시 Swagger UI 정상 표시
   - 주요 3개 Controller의 API 문서 확인 가능
   - Authorize 버튼으로 JWT Bearer Token 인증 테스트 가능
   - API 문서와 실제 코드 자동 동기화
```

**커밋 정보**:
- Branch: `feat/backend-quality-improvements`
- Commit: `cb8f2a0`
- Status: ✅ 완료

---

### Story 2: 운영 모니터링 및 안정성 강화

**본문**:
```
1. **개요 (Context)**
   - 운영 환경에서 시스템 상태를 실시간으로 모니터링할 수 있도록 헬스체크 강화
   - 로봇 연결 상태, WebSocket 세션 등 핵심 지표를 Actuator로 추적

2. **작업 상세 내용 (To-Do)**
   - 로봇 연결 상태를 확인하는 커스텀 Health Indicator 구현
   - WebSocket 세션을 확인하는 커스텀 Health Indicator 구현
   - Actuator 엔드포인트 설정 및 노출

3. **완료 기준 (Definition of Done)**
   - /actuator/health 엔드포인트 정상 응답
   - 로봇 연결 수 및 WebSocket 활성 세션 수 실시간 확인 가능
   - CI/CD 파이프라인에서 health check 활용 가능
```

---

### Task 2: [Feat][BE] Health Check & Metrics 모니터링 강화

**본문**:
```
1. **개요 (Context)**
   - 로봇 연결 상태와 WebSocket 세션을 Actuator로 모니터링하여 운영 안정성 확보
   - 운영팀이 /actuator/health 엔드포인트로 시스템 상태를 실시간 확인 가능

2. **작업 상세 내용 (To-Do)**
   - RobotHealthIndicator 구현 (연결된 로봇 수 확인, UP/DOWN 자동 판별)
   - WebSocketHealthIndicator 구현 (STOMP 활성 세션 수 확인)
   - application.properties에 Actuator 엔드포인트 노출 설정 추가
   - 인증된 사용자에게 상세 정보 표시 설정

3. **완료 기준 (Definition of Done)**
   - /actuator/health 정상 응답 및 robot, webSocket 컴포넌트 표시
   - 1대 이상 로봇 연결 시 UP, 미연결 시 DOWN 상태 자동 판별
   - 연결된 로봇 수, WebSocket 활성 세션 수 등 상세 정보 확인 가능
   - health, info, metrics, loggers 엔드포인트 노출
```

**커밋 정보**:
- Branch: `feat/backend-quality-improvements`
- Commit: `95d59e2`
- Status: ✅ 완료

---

## 🔄 수동 생성 방법 (스크립트 실패 시)

1. Jira 웹 접속: https://ssafy.atlassian.net/browse/S15P11E101
2. Epic 생성 → "Create" 버튼
3. Story 생성 (parent = Epic)
4. Task 생성 (parent = Epic, **Story 아님!**)
5. Task와 Story를 "Relates" 링크로 연결

---

## ✅ 생성 후 작업

1. **MR 본문 업데이트**: 생성된 Jira 티켓 URL 추가
2. **브랜치명 확인**: `feat/S15P11E101-XXX-swagger` (티켓 번호 포함)
3. **커밋 메시지 수정** (선택): `[S15P11E101-XXX] feat: [BE] ...`
4. **Jira 상태 업데이트**: Task를 "Done"으로 이동

---

## 📚 참고 문서

- [CLAUDE.md](../CLAUDE.md) - Jira 자동화 컨벤션
- [AI.md](../AI.md) - 통합 AI 협업 가이드
- [docs/jira_convention.md](../docs/jira_convention.md) - Jira 협업 컨벤션
