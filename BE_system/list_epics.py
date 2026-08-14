#!/usr/bin/env python3
"""
Jira Epic 목록 조회 스크립트
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

def main():
    config = load_jira_config()

    # Epic 조회 JQL
    jql = f'project = {config["project_key"]} AND issuetype = Epic ORDER BY created DESC'

    url = f"{config['jira_url']}/rest/api/3/search/jql"
    auth = HTTPBasicAuth(config['jira_email'], config['jira_api_token'])

    params = {
        'jql': jql,
        'maxResults': 20,
        'fields': 'key,summary,status'
    }

    response = requests.get(url, auth=auth, params=params)

    if response.status_code == 200:
        data = response.json()
        epics = data.get('issues', [])

        print("=" * 80)
        print(f"프로젝트 {config['project_key']}의 Epic 목록")
        print("=" * 80)
        print()

        if not epics:
            print("Epic이 없습니다.")
            return

        for i, epic in enumerate(epics, 1):
            key = epic['key']
            summary = epic['fields']['summary']
            status = epic['fields']['status']['name']

            print(f"{i}. [{key}] {summary}")
            print(f"   상태: {status}")
            print(f"   URL: https://ssafy.atlassian.net/browse/{key}")
            print()
    else:
        print(f"❌ Epic 조회 실패: {response.status_code}")
        print(response.text)

if __name__ == "__main__":
    main()
