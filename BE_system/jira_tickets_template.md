# Jira 티켓 생성 가이드 - 백엔드 품질 개선

## 티켓 구조

```
Epic (lv2)
  └── Story 1 (lv1): API 문서화 및 개발 경험 개선
       └── Task 1-1 (lv0): Swagger/OpenAPI 3.0 추가
  └── Story 2 (lv1): 운영 모니터링 및 안정성 강화
       └── Task 2-1 (lv0): Health Check & Metrics 강화
```

---

## Epic

**제목**: `[Feat][BE] 백엔드 품질 및 운영성 개선`

**설명**:
```markdown
1. **개요 (Context)**
   - 백엔드 시스템의 개발 생산성, 운영 안정성, 코드 품질을 전반적으로 향상시키는 개선 작업
   - API 문서 자동화, 모니터링 강화, 에러 처리 표준화, 성능 최적화 등을 단계적으로 진행
   - 포트폴리오 가치 향상 및 실무 운영 환경 준비

2. **작업 상세 내용 (To-Do)**
   - API 문서 자동화 (Swagger/OpenAPI)
   - 헬스체크 및 메트릭 모니터링 강화
   - 구조화된 로깅 시스템 구축
   - RFC 7807 표준 에러 응답
   - DTO Validation 강화
   - JPA 성능 최적화
   - 테스트 커버리지 향상

3. **완료 기준 (Definition of Done)**
   - 모든 하위 Story 및 Task 완료
   - 운영 환경 배포 및 정상 동작 확인
   - 개발 문서 업데이트
```

**기타 필드**:
- Story Points: 13
- Priority: High
- Labels: Backend, Quality, DevOps
- Due Date: 다음 금요일

---

## Story 1: API 문서화 및 개발 경험 개선

**제목**: `[Feat][BE] API 문서화 및 개발 경험 개선`

**설명**:
```markdown
1. **개요 (Context)**
   - API 문서를 마크다운에서 자동 생성되는 Swagger UI로 전환
   - 프론트엔드 개발자가 실시간으로 API 테스트 가능하도록 개선
   - API 문서와 코드 동기화 자동 보장

2. **작업 상세 내용 (To-Do)**
   - SpringDoc OpenAPI 3.0 도입
   - 모든 Controller에 OpenAPI 어노테이션 추가
   - JWT 인증 연동 설정
   - Swagger UI 접근 권한 설정

3. **완료 기준 (Definition of Done)**
   - Swagger UI 접속 가능 (http://localhost:8080/swagger-ui.html)
   - 모든 REST API 문서화 완료
   - JWT 토큰으로 인증 API 테스트 가능
```

**기타 필드**:
- Story Points: 5
- Priority: High
- Labels: Backend, Documentation, DX
- Parent: Epic (위에서 생성한 Epic의 키)
- Due Date: 다음 금요일

---

## Task 1-1: Swagger/OpenAPI 3.0 추가

**제목**: `[Feat][BE] Swagger/OpenAPI 3.0 API 문서 자동화 추가`

**설명**:
```markdown
1. **개요 (Context)**
   - SpringDoc OpenAPI를 사용하여 REST API 문서를 자동 생성
   - 개발자가 /swagger-ui.html에서 실시간으로 API 테스트 가능

2. **작업 상세 내용 (To-Do)**
   - SpringDoc OpenAPI 의존성 추가 (build.gradle)
   - OpenApiConfig 설정 클래스 작성
   - SecurityConfig에 Swagger UI 접근 허용
   - AuthController, RobotController, EventController에 어노테이션 추가

3. **완료 기준 (Definition of Done)**
   - Swagger UI 정상 동작
   - JWT Bearer Token 인증 테스트 가능
   - 3개 Controller 문서화 완료
```

**기타 필드**:
- Story Points: 3
- Priority: High
- Labels: Backend, Documentation, Swagger
- Parent: Epic (Story가 아닌 Epic!)
- Linked Issues: Story 1에 "Relates" 링크
- Due Date: 다음 금요일

**커밋 정보**:
- Branch: `feat/backend-quality-improvements`
- Commit: `cb8f2a0`

---

## Story 2: 운영 모니터링 및 안정성 강화

**제목**: `[Feat][BE] 운영 모니터링 및 안정성 강화`

**설명**:
```markdown
1. **개요 (Context)**
   - 운영 환경에서 시스템 상태를 실시간으로 모니터링
   - 로봇 연결 상태, WebSocket 세션 등 핵심 지표 추적
   - CI/CD 파이프라인 헬스체크 연동

2. **작업 상세 내용 (To-Do)**
   - 커스텀 Health Indicator 구현
   - Actuator 엔드포인트 설정
   - 메트릭 수집 및 노출

3. **완료 기준 (Definition of Done)**
   - /actuator/health 정상 응답
   - 로봇 및 WebSocket 상태 실시간 반영
   - CI/CD에서 health check 활용 가능
```

**기타 필드**:
- Story Points: 3
- Priority: High
- Labels: Backend, Monitoring, DevOps
- Parent: Epic
- Due Date: 다음 금요일

---

## Task 2-1: Health Check & Metrics 강화

**제목**: `[Feat][BE] Health Check & Metrics 모니터링 강화`

**설명**:
```markdown
1. **개요 (Context)**
   - 로봇 연결 상태와 WebSocket 세션을 Actuator로 모니터링
   - 운영팀이 시스템 상태를 실시간으로 확인 가능

2. **작업 상세 내용 (To-Do)**
   - RobotHealthIndicator 구현 (연결된 로봇 수 확인)
   - WebSocketHealthIndicator 구현 (STOMP 세션 확인)
   - application.properties에 Actuator 설정 추가

3. **완료 기준 (Definition of Done)**
   - /actuator/health에서 robot, webSocket 컴포넌트 확인 가능
   - UP/DOWN 상태 자동 판별
   - 상세 정보 (연결 수, 세션 수 등) 표시
```

**기타 필드**:
- Story Points: 2
- Priority: High
- Labels: Backend, Monitoring, Health
- Parent: Epic
- Linked Issues: Story 2에 "Relates" 링크
- Due Date: 다음 금요일

**커밋 정보**:
- Branch: `feat/backend-quality-improvements`
- Commit: `95d59e2`

---

## Jira 티켓 생성 방법

### 방법 1: Jira 웹 UI에서 수동 생성
1. Jira 프로젝트 접속 (https://ssafy.atlassian.net/browse/S15P11E101)
2. Epic 생성 → Story 생성 (parent = Epic) → Task 생성 (parent = Epic)
3. Task와 Story를 "Relates" 이슈 링크로 연결

### 방법 2: Python 스크립트 사용 (준비 필요)
1. 루트 디렉토리에 `.ai_jira_config.json` 파일 생성:
```json
{
  "jira_url": "https://ssafy.atlassian.net",
  "jira_email": "your-email@ssafy.com",
  "jira_api_token": "your-api-token",
  "project_key": "S15P11E101"
}
```

2. Python 스크립트 실행 (스크립트는 별도 작성 필요)

### 방법 3: Jira REST API 직접 호출
위 템플릿 정보를 사용하여 Jira REST API로 직접 생성 가능

---

## 생성 후 작업
1. MR 본문에 Jira 티켓 URL 추가
2. 커밋 메시지에 Jira 티켓 번호 포함 (이미 완료됨)
3. GitLab-Jira 연동으로 자동 링크 생성 확인
