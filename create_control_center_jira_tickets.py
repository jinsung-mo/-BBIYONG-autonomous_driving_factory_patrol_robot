#!/usr/bin/env python3
import requests
import json
from datetime import datetime, timedelta
import sys

# Load config
with open('.ai_jira_config.json', 'r') as f:
    config = json.load(f)

JIRA_URL = config['jira_url']
EMAIL = config['jira_email']
API_TOKEN = config['jira_api_token']
PROJECT_KEY = config['project_key']

AUTH = (EMAIL, API_TOKEN)
HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
}

# Get next Friday
def get_next_friday():
    today = datetime.now()
    days_until_friday = (4 - today.weekday() + 7) % 7
    if days_until_friday == 0:
        days_until_friday = 7
    next_friday = today + timedelta(days=days_until_friday)
    return next_friday.strftime('%Y-%m-%d')

DUE_DATE = get_next_friday()

# Epic ID for "관제센터 (Control Center)"
EPIC_KEY = "S15P11E101-3"

# Stories and Tasks
STORIES = [
    {
        "title": "[BE] Mattermost 알림 설정",
        "description": """1. **개요 (Context)**
   - 관제센터에서 화재/과열 이벤트 발생 시 Mattermost로 실시간 알림을 전송하는 기능
   - 사용자별로 알림 활성화 여부, 웹훅 URL, 채널, 최소 심각도를 설정 가능

2. **작업 상세 내용 (To-Do)**
   - NotificationSetting 엔티티 및 Repository 구현
   - 알림 설정 CRUD API 구현 (GET/PUT /api/notifications/settings)
   - Mattermost 웹훅 전송 서비스 구현
   - EventLogService에 알림 전송 로직 통합
   - RestTemplate 설정 추가

3. **완료 기준 (Definition of Done)**
   - 사용자별 알림 설정 조회/수정 가능
   - 이벤트 발생 시 조건에 맞는 사용자에게 Mattermost 알림 전송
   - 빌드 및 테스트 통과
   - Swagger 문서 업데이트""",
        "tasks": [
            {
                "title": "[BE] Mattermost 알림 설정 API 구현",
                "description": """1. **개요 (Context)**
   - Mattermost 알림 설정 엔티티, 서비스, 컨트롤러 구현

2. **작업 상세 내용 (To-Do)**
   - NotificationSetting, NotificationSettingRepository 구현
   - NotificationSettingRequest/Response DTO 구현
   - NotificationService 구현 (getSettings, updateSettings, shouldNotify)
   - NotificationController 구현 (GET/PUT /api/notifications/settings)
   - MattermostNotifier 서비스 구현 (웹훅 전송)
   - EventLogService에 알림 발송 로직 통합
   - RestTemplateConfig 추가

3. **완료 기준 (Definition of Done)**
   - 컴파일 오류 없음
   - 알림 설정 CRUD 동작 확인
   - 이벤트 발생 시 Mattermost 알림 전송 확인"""
            }
        ]
    },
    {
        "title": "[BE] 자동 순찰 스케줄러",
        "description": """1. **개요 (Context)**
   - 관제센터에서 특정 시간에 자동으로 순찰을 시작하도록 스케줄 설정
   - Cron 표현식을 사용하여 유연한 시간 설정 지원

2. **작업 상세 내용 (To-Do)**
   - PatrolSchedule 엔티티 및 Repository 구현
   - 스케줄 CRUD API 구현
   - TaskScheduler를 이용한 동적 스케줄링 구현
   - 애플리케이션 시작 시 활성화된 스케줄 자동 로드

3. **완료 기준 (Definition of Done)**
   - 스케줄 생성/수정/삭제 가능
   - Cron 표현식 유효성 검사 통과
   - 스케줄 시간에 자동으로 순찰 경로 하달
   - 빌드 및 테스트 통과""",
        "tasks": [
            {
                "title": "[BE] 자동 순찰 스케줄러 구현",
                "description": """1. **개요 (Context)**
   - Cron 표현식 기반 자동 순찰 스케줄러 구현

2. **작업 상세 내용 (To-Do)**
   - PatrolSchedule 엔티티, PatrolScheduleRepository 구현
   - PatrolScheduleRequest/Response DTO 구현
   - PatrolSchedulerService 구현 (동적 스케줄링)
   - PatrolScheduleService 구현 (CRUD)
   - PatrolScheduleController 구현 (GET/POST/PUT/DELETE)
   - SchedulerConfig 추가 (TaskScheduler Bean)

3. **완료 기준 (Definition of Done)**
   - Cron 표현식 파싱 및 유효성 검사 통과
   - 스케줄 CRUD 동작 확인
   - 스케줄 시간에 순찰 자동 실행 확인"""
            }
        ]
    },
    {
        "title": "[BE] 로봇 건강 이력 API",
        "description": """1. **개요 (Context)**
   - 로봇의 배터리, 통신 지연, FPS 등 건강 상태를 시계열로 수집하고 조회
   - 차트 렌더링을 위한 시계열 데이터 제공

2. **작업 상세 내용 (To-Do)**
   - RobotHealthHistory 엔티티 및 Repository 구현
   - 1분마다 로봇 상태 자동 수집 (Scheduled Task)
   - 기간별 건강 이력 조회 API 구현
   - 오래된 데이터 자동 정리 (30일 이상)

3. **완료 기준 (Definition of Done)**
   - 1분마다 로봇 상태 데이터 자동 수집
   - GET /api/robots/{robotId}/health-history?period=24h 동작 확인
   - 차트용 시계열 데이터 응답 형식 확인
   - 빌드 및 테스트 통과""",
        "tasks": [
            {
                "title": "[BE] 로봇 건강 이력 API 구현",
                "description": """1. **개요 (Context)**
   - 로봇 건강 상태 시계열 데이터 수집 및 조회 API 구현

2. **작업 상세 내용 (To-Do)**
   - RobotHealthHistory 엔티티, Repository 구현
   - RobotHealthHistoryResponse DTO 구현
   - RobotHealthHistoryService 구현 (수집, 조회, 정리)
   - @Scheduled 메서드로 1분마다 데이터 수집
   - @Scheduled 메서드로 매일 자정 오래된 데이터 삭제
   - RobotController에 건강 이력 조회 엔드포인트 추가

3. **완료 기준 (Definition of Done)**
   - 1분마다 로봇 상태 수집 확인
   - 기간별 조회 (1h, 6h, 24h, 7d) 동작 확인
   - 차트용 데이터 포맷 확인"""
            }
        ]
    },
    {
        "title": "[BE] 이벤트 통계 차트 API",
        "description": """1. **개요 (Context)**
   - 관제센터 대시보드에 표시할 이벤트 발생 통계 차트 데이터 제공
   - 시간별, 일별, 로봇별, 설비별, 타입별 통계 지원

2. **작업 상세 내용 (To-Do)**
   - EventStatsResponse DTO 구현
   - EventStatsService 구현 (시간별/일별/로봇별/설비별/타입별 통계)
   - 5개의 통계 조회 API 구현

3. **완료 기준 (Definition of Done)**
   - 시간별/일별 통계 데이터 조회 가능
   - 로봇별/설비별/타입별 통계 데이터 조회 가능
   - 차트 렌더링용 데이터 포맷 확인
   - 빌드 및 테스트 통과""",
        "tasks": [
            {
                "title": "[BE] 이벤트 통계 차트 API 구현",
                "description": """1. **개요 (Context)**
   - 이벤트 발생 통계 데이터를 다양한 기준으로 집계하여 차트용 데이터 제공

2. **작업 상세 내용 (To-Do)**
   - EventStatsResponse DTO 구현
   - EventStatsService 구현
     - getHourlyStats: 시간별 통계
     - getDailyStats: 일별 통계
     - getStatsByRobot: 로봇별 통계
     - getStatsByEquipment: 설비별 통계
     - getStatsByType: 타입별 통계
   - EventController에 5개의 통계 엔드포인트 추가

3. **완료 기준 (Definition of Done)**
   - 모든 통계 API 동작 확인
   - DataPoint 형식으로 차트용 데이터 반환 확인"""
            }
        ]
    }
]

def create_issue(issue_type, summary, description, parent_key=None):
    """Create a Jira issue"""
    url = f"{JIRA_URL}/rest/api/3/issue"

    payload = {
        "fields": {
            "project": {"key": PROJECT_KEY},
            "summary": summary,
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": description
                            }
                        ]
                    }
                ]
            },
            "issuetype": {"name": issue_type},
            "duedate": DUE_DATE
        }
    }

    # Add parent (Epic) for Story and Task
    if parent_key:
        payload["fields"]["parent"] = {"key": parent_key}

    response = requests.post(url, headers=HEADERS, auth=AUTH, json=payload)

    if response.status_code == 201:
        issue_key = response.json()['key']
        print(f"✓ Created {issue_type}: {issue_key} - {summary}")
        return issue_key
    else:
        print(f"✗ Failed to create {issue_type}: {summary}")
        print(f"  Status: {response.status_code}")
        print(f"  Response: {response.text}")
        return None

def create_issue_link(inward_key, outward_key, link_type="Relates"):
    """Create an issue link between two issues"""
    url = f"{JIRA_URL}/rest/api/3/issueLink"

    payload = {
        "type": {"name": link_type},
        "inwardIssue": {"key": inward_key},
        "outwardIssue": {"key": outward_key}
    }

    response = requests.post(url, headers=HEADERS, auth=AUTH, json=payload)

    if response.status_code == 201:
        print(f"  ✓ Linked {outward_key} to {inward_key}")
        return True
    else:
        print(f"  ✗ Failed to link {outward_key} to {inward_key}")
        print(f"    Status: {response.status_code}")
        print(f"    Response: {response.text}")
        return False

def main():
    print(f"Creating Jira tickets for Control Center features...")
    print(f"Epic: {EPIC_KEY}")
    print(f"Due Date: {DUE_DATE}\n")

    for story_data in STORIES:
        # Create Story with Epic as parent
        story_key = create_issue(
            "Story",
            story_data["title"],
            story_data["description"],
            parent_key=EPIC_KEY
        )

        if not story_key:
            continue

        # Create Tasks for this Story
        for task_data in story_data["tasks"]:
            task_key = create_issue(
                "Task",
                task_data["title"],
                task_data["description"],
                parent_key=EPIC_KEY  # Task also has Epic as parent
            )

            if task_key:
                # Link Task to Story with "Relates" link
                create_issue_link(task_key, story_key, "Relates")

        print()

    print("✓ All Jira tickets created successfully!")

if __name__ == "__main__":
    main()
