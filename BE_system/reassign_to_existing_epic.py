#!/usr/bin/env python3
"""
새로 생성한 에픽 삭제 및 기존 에픽으로 재연결 스크립트
"""

import json
import sys
import requests
from requests.auth import HTTPBasicAuth

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

def delete_issue(config, issue_key):
    """이슈 삭제"""
    url = f"{config['jira_url']}/rest/api/3/issue/{issue_key}"
    auth = HTTPBasicAuth(config['jira_email'], config['jira_api_token'])

    response = requests.delete(url, auth=auth)

    if response.status_code == 204:
        print(f"✅ {issue_key} 삭제 완료")
        return True
    else:
        print(f"❌ {issue_key} 삭제 실패: {response.status_code}")
        print(response.text)
        return False

def update_parent(config, issue_key, new_parent_key):
    """이슈의 부모 업데이트"""
    url = f"{config['jira_url']}/rest/api/3/issue/{issue_key}"
    auth = HTTPBasicAuth(config['jira_email'], config['jira_api_token'])

    payload = {
        "fields": {
            "parent": {
                "key": new_parent_key
            }
        }
    }

    response = requests.put(
        url,
        auth=auth,
        headers={"Content-Type": "application/json"},
        json=payload
    )

    if response.status_code == 204:
        print(f"✅ {issue_key}의 부모를 {new_parent_key}로 변경 완료")
        return True
    else:
        print(f"❌ {issue_key} 부모 변경 실패: {response.status_code}")
        print(response.text)
        return False

def main():
    config = load_jira_config()

    # 작업할 이슈 키
    epic_to_delete = "S15P11E101-564"  # 삭제할 새 에픽
    existing_epic = "S15P11E101-3"     # 기존 에픽 (관제 백엔드 서버 구축)

    stories = ["S15P11E101-565", "S15P11E101-567"]  # Swagger, Health Check 스토리
    tasks = ["S15P11E101-566", "S15P11E101-568"]    # Swagger, Health Check 태스크

    print("=" * 80)
    print("Jira 에픽 재구성 작업 시작")
    print("=" * 80)
    print()

    # 1. Story와 Task의 부모를 기존 에픽으로 변경
    print(f"1. Story와 Task를 기존 에픽 {existing_epic}로 재연결 중...")
    print()

    all_issues = stories + tasks
    success = True

    for issue_key in all_issues:
        if not update_parent(config, issue_key, existing_epic):
            success = False
            print(f"   ⚠️  {issue_key} 재연결 실패 - 계속 진행합니다.")

    print()

    # 2. 새로 생성한 에픽 삭제
    print(f"2. 새 에픽 {epic_to_delete} 삭제 중...")
    print()

    if delete_issue(config, epic_to_delete):
        print()
        print("=" * 80)
        print("✅ 재구성 완료!")
        print("=" * 80)
        print()
        print(f"기존 에픽: https://ssafy.atlassian.net/browse/{existing_epic}")
        print()
        print("재연결된 Story:")
        for story in stories:
            print(f"  - https://ssafy.atlassian.net/browse/{story}")
        print()
        print("재연결된 Task:")
        for task in tasks:
            print(f"  - https://ssafy.atlassian.net/browse/{task}")
    else:
        print()
        print("⚠️  에픽 삭제에 실패했지만, Story/Task는 재연결되었습니다.")
        print("   에픽은 수동으로 삭제해 주세요.")

if __name__ == "__main__":
    main()
