#!/usr/bin/env python3
"""
대시보드 및 이벤트 필터링 기능 Jira 티켓 생성
"""

import json
import sys
import requests
from requests.auth import HTTPBasicAuth
from datetime import datetime, timedelta

def load_jira_config():
    config_paths = ['../.ai_jira_config.json', '../.gemini_jira_config.json']
    for path in config_paths:
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except:
            pass
    print("❌ Jira 설정 파일을 찾을 수 없습니다.")
    sys.exit(1)

def get_next_friday():
    """다음 금요일 날짜 반환"""
    today = datetime.now()
    days_ahead = 4 - today.weekday()  # 0=월요일, 4=금요일
    if days_ahead <= 0:
        days_ahead += 7
    next_friday = today + timedelta(days=days_ahead)
    return next_friday.strftime("%Y-%m-%d")

def create_issue(config, issue_type, summary, description, parent_key=None):
    """Jira 이슈 생성"""
    url = f"{config['jira_url']}/rest/api/3/issue"
    auth = HTTPBasicAuth(config['jira_email'], config['jira_api_token'])

    payload = {
        "fields": {
            "project": {"key": config['project_key']},
            "summary": summary,
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": description}]
                    }
                ]
            },
            "issuetype": {"name": issue_type},
            "labels": ["BE"],
            "duedate": get_next_friday()
        }
    }

    if parent_key:
        payload["fields"]["parent"] = {"key": parent_key}

    response = requests.post(url, auth=auth, headers={"Content-Type": "application/json"}, json=payload)

    if response.status_code == 201:
        issue_data = response.json()
        print(f"✅ {issue_type} 생성 완료: {issue_data['key']} - {summary}")
        return issue_data['key']
    else:
        print(f"❌ {issue_type} 생성 실패: {response.status_code}")
        print(response.text)
        return None

def create_issue_link(config, from_key, to_key, link_type="Relates"):
    """이슈 간 링크 생성"""
    url = f"{config['jira_url']}/rest/api/3/issueLink"
    auth = HTTPBasicAuth(config['jira_email'], config['jira_api_token'])

    payload = {
        "type": {"name": link_type},
        "inwardIssue": {"key": to_key},
        "outwardIssue": {"key": from_key}
    }

    response = requests.post(url, auth=auth, headers={"Content-Type": "application/json"}, json=payload)

    if response.status_code == 201:
        print(f"  ✅ 링크 생성: {from_key} -> {to_key}")
        return True
    else:
        print(f"  ⚠️  링크 생성 실패: {response.status_code}")
        return False

def main():
    config = load_jira_config()
    existing_epic = "S15P11E101-3"  # 관제 백엔드 서버 구축 및 실시간 소켓 통신

    print("=" * 80)
    print("관제센터 대시보드 및 이벤트 필터링 Jira 티켓 생성")
    print("=" * 80)
    print()

    # Story 1: 대시보드 통계 API
    story1_desc = """1. **개요 (Context)**
   - 관제센터 메인 화면에서 전체 시스템 상태를 한눈에 파악할 수 있는 통합 통계 API 필요
   - 로봇 상태, 이벤트 통계, 최근 경보 등을 단일 요청으로 조회

2. **작업 상세 내용 (To-Do)**
   - DashboardStatsResponse DTO 설계 및 구현
   - DashboardService 비즈니스 로직 구현 (로봇 요약, 오늘 이벤트 통계)
   - DashboardController REST API 구현 (GET /api/dashboard/stats)
   - EventLogRepository에 통계 쿼리 메서드 추가
   - Swagger API 문서화

3. **완료 기준 (Definition of Done)**
   - 빌드 및 컴파일 성공
   - API 호출 시 JSON 응답 정상 반환
   - Swagger UI에서 API 문서 확인 가능
   - 로봇 수, 배터리 평균, 이벤트 통계가 정확히 집계됨
"""

    story1_key = create_issue(config, "Story", "[Feat][BE] 관제센터 대시보드 통합 통계 API", story1_desc, existing_epic)

    if story1_key:
        # Task 1-1: 대시보드 통계 API 구현
        task1_desc = """1. **개요 (Context)**
   - 대시보드 통계 API의 핵심 로직 구현

2. **작업 상세 내용 (To-Do)**
   - DashboardStatsResponse, RobotSummary, TodayStats DTO 작성
   - DashboardService: 로봇 상태 집계, 이벤트 통계 계산
   - DashboardController: GET /api/dashboard/stats 엔드포인트
   - EventLogRepository: findByTimestampAfter, findLatestEvents 메서드 추가

3. **완료 기준 (Definition of Done)**
   - 전체 로봇 수, 활동중/충전중 로봇 수, 평균 배터리 계산 정확
   - 오늘 이벤트 수, 치명적/경고/해결/미해결 이벤트 수 집계 정확
   - 최근 5건 이벤트 시간 역순으로 조회
   - Swagger 문서에 응답 예시 포함
"""

        task1_key = create_issue(config, "Task", "[Feat][BE] 대시보드 통합 통계 API 구현", task1_desc, existing_epic)
        if task1_key:
            create_issue_link(config, task1_key, story1_key)

    # Story 2: 이벤트 필터링 강화
    story2_desc = """1. **개요 (Context)**
   - 관제요원이 특정 조건의 이벤트만 빠르게 조회할 수 있도록 고급 필터링 기능 필요
   - 타입, 심각도, 상태, 로봇, 설비, 날짜 범위 등 다양한 조건 지원

2. **작업 상세 내용 (To-Do)**
   - EventFilterRequest DTO 설계
   - EventLogSpecification JPA Criteria API 동적 쿼리 구현
   - EventLogService에 필터링 메서드 추가
   - EventController API 파라미터 확장
   - Swagger 문서에 필터링 예시 추가

3. **완료 기준 (Definition of Done)**
   - 모든 필터 조합이 정상 동작
   - 날짜 범위 필터링 정확 (시작일 00:00:00 ~ 종료일 23:59:59)
   - 잘못된 날짜 형식 시 400 Bad Request 응답
   - Swagger UI에서 필터 파라미터 확인 가능
"""

    story2_key = create_issue(config, "Story", "[Feat][BE] 이벤트 이력 고급 필터링", story2_desc, existing_epic)

    if story2_key:
        # Task 2-1: 이벤트 필터링 구현
        task2_desc = """1. **개요 (Context)**
   - 이벤트 필터링 API의 핵심 로직 구현

2. **작업 상세 내용 (To-Do)**
   - EventFilterRequest DTO 작성 (type, level, status, robotId, equipmentId, startDate, endDate)
   - EventLogSpecification.withFilters() 메서드 구현 (JPA Criteria API)
   - EventLogRepository에 JpaSpecificationExecutor 인터페이스 추가
   - EventLogService.getEventsWithFilters() 메서드 구현
   - EventController GET /api/events 파라미터 확장

3. **완료 기준 (Definition of Done)**
   - type=FIRE&status=UNRESOLVED 필터링 정상 동작
   - robotId=E101&startDate=2026-08-01 필터링 정상 동작
   - 날짜 파싱 에러 시 명확한 에러 메시지 반환
   - 모든 필터가 AND 조건으로 결합되어 동작
"""

        task2_key = create_issue(config, "Task", "[Feat][BE] 이벤트 고급 필터링 API 구현", task2_desc, existing_epic)
        if task2_key:
            create_issue_link(config, task2_key, story2_key)

    print()
    print("=" * 80)
    print("✅ 티켓 생성 완료")
    print("=" * 80)
    print()
    print(f"Epic: https://ssafy.atlassian.net/browse/{existing_epic}")
    if story1_key:
        print(f"Story 1: https://ssafy.atlassian.net/browse/{story1_key}")
    if story2_key:
        print(f"Story 2: https://ssafy.atlassian.net/browse/{story2_key}")

if __name__ == "__main__":
    main()
