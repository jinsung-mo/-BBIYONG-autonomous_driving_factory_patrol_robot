#!/bin/bash
# Antigravity Jira MCP 자동 설정 스크립트 (macOS / Linux용)
# 실행 방법: chmod +x setup-mcp.sh && ./setup-mcp.sh

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$PROJECT_ROOT/.ai_jira_config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="$PROJECT_ROOT/.gemini_jira_config.json"
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "\033[31m[Error] .ai_jira_config.json 또는 .gemini_jira_config.json 파일이 존재하지 않습니다. 먼저 설정 파일을 작성해 주세요.\033[0m"
  exit 1
fi

echo -e "\033[36mReading project Jira config...\033[0m"

# 글로벌 설정 디렉토리 확인 및 생성
GEMINI_DIR="$HOME/.gemini/config"
mkdir -p "$GEMINI_DIR"
MCP_CONFIG="$GEMINI_DIR/mcp_config.json"

# Python 스크립트를 사용하여 JSON을 파싱하고 병합
python3 -c "
import json
import os

project_config_path = '$CONFIG_FILE'
mcp_config_path = '$MCP_CONFIG'

with open(project_config_path, 'r', encoding='utf-8') as f:
    proj_cfg = json.load(f)

mcp_cfg = {'mcpServers': {}}
if os.path.exists(mcp_config_path) and os.path.getsize(mcp_config_path) > 0:
    try:
        with open(mcp_config_path, 'r', encoding='utf-8') as f:
            mcp_cfg = json.load(f)
    except Exception:
        pass

if 'mcpServers' not in mcp_cfg:
    mcp_cfg['mcpServers'] = {}

# jira_url(예: https://ssafy.atlassian.net)에서 사이트 이름(예: ssafy) 추출
site_name = proj_cfg.get('jira_url', '').replace('https://', '').replace('http://', '').split('.atlassian.net')[0].strip('/')

mcp_cfg['mcpServers']['jira'] = {
    'command': 'npx',
    'args': ['-y', '@aashari/mcp-server-atlassian-jira'],
    'env': {
        'ATLASSIAN_SITE_NAME': site_name,
        'ATLASSIAN_USER_EMAIL': proj_cfg.get('jira_email', ''),
        'ATLASSIAN_API_TOKEN': proj_cfg.get('jira_api_token', '')
    }
}

with open(mcp_config_path, 'w', encoding='utf-8') as f:
    json.dump(mcp_cfg, f, indent=2, ensure_ascii=False)

print('\033[32mSuccessfully updated mcp_config.json at:', mcp_config_path, '\033[0m')
"

echo -e "\n\033[32m[Success] Jira MCP 설정이 정상적으로 완료되었습니다!\033[0m"
echo -e "\033[32m이제 Antigravity CLI(agy) 또는 IDE를 재실행하시면 지라 티켓 관련 명령어를 AI가 자동 인지하고 수행합니다.\033[0m\n"
