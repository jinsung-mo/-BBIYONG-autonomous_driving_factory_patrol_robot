#!/usr/bin/env python3
"""
Jira 티켓 담당자 지정
"""

import json
import sys
import requests
from requests.auth import HTTPBasicAuth

def load_jira_config():
    import os
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    config_paths = [os.path.join(repo_root, n) for n in ('.ai_jira_config.json', '.gemini_jira_config.json')]
    for path in config_paths:
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except:
            pass
    print("❌ Jira 설정 파일을 찾을 수 없습니다.")
    sys.exit(1)

def assign_issue(config, issue_key, assignee_email):
    """이슈 담당자 지정"""
    url = f"{config['jira_url']}/rest/api/3/issue/{issue_key}/assignee"
    auth = HTTPBasicAuth(config['jira_email'], config['jira_api_token'])

    payload = {
        "accountId": None  # email 대신 accountId를 찾아야 함
    }

    # 먼저 사용자 검색
    search_url = f"{config['jira_url']}/rest/api/3/user/search?query={assignee_email}"
    search_response = requests.get(search_url, auth=auth)

    if search_response.status_code == 200:
        users = search_response.json()
        if users:
            account_id = users[0]['accountId']
            payload['accountId'] = account_id

            # 담당자 지정
            response = requests.put(url, auth=auth, headers={"Content-Type": "application/json"}, json=payload)

            if response.status_code == 204:
                print(f"✅ {issue_key} 담당자 지정 완료: {assignee_email}")
                return True
            else:
                print(f"❌ {issue_key} 담당자 지정 실패: {response.status_code}")
                print(response.text)
                return False
        else:
            print(f"⚠️  사용자를 찾을 수 없습니다: {assignee_email}")
            return False
    else:
        print(f"❌ 사용자 검색 실패: {search_response.status_code}")
        return False

def main():
    config = load_jira_config()
    assignee_email = config['jira_email']  # 설정 파일의 이메일 사용

    print("=" * 80)
    print(f"Jira 티켓 담당자 지정: {assignee_email}")
    print("=" * 80)
    print()

    # 생성한 티켓들
    tickets = [
        "S15P11E101-572",  # Story 1: 대시보드 통계 API
        "S15P11E101-573",  # Task 1: 대시보드 구현
        "S15P11E101-574",  # Story 2: 이벤트 필터링
        "S15P11E101-575",  # Task 2: 필터링 구현
    ]

    for ticket in tickets:
        assign_issue(config, ticket, assignee_email)

    print()
    print("=" * 80)
    print("✅ 담당자 지정 완료")
    print("=" * 80)

if __name__ == "__main__":
    main()
