# Antigravity Jira MCP 자동 설정 스크립트 (Windows PowerShell용)
# 실행 방법: PowerShell에서 .\setup-mcp.ps1 실행

$ErrorActionPreference = "Stop"

# 1. 로컬 프로젝트 설정 파일 확인
$projectConfigPath = Join-Path $PSScriptRoot ".ai_jira_config.json"
if (-not (Test-Path $projectConfigPath)) {
    $projectConfigPath = Join-Path $PSScriptRoot ".gemini_jira_config.json"
}
if (-not (Test-Path $projectConfigPath)) {
    Write-Error "[Error] 프로젝트 루트에 .ai_jira_config.json 또는 .gemini_jira_config.json 파일이 존재하지 않습니다. 먼저 설정 파일을 작성해 주세요."
    exit 1
}

Write-Host "Reading project Jira config..." -ForegroundColor Cyan
$projectConfig = Get-Content -Raw -Path $projectConfigPath | ConvertFrom-Json

# 2. 글로벌 .gemini 설정 폴더 확인 및 생성
$geminiConfigDir = Join-Path $home ".gemini\config"
if (-not (Test-Path $geminiConfigDir)) {
    Write-Host "Creating global .gemini/config directory at $geminiConfigDir..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $geminiConfigDir | Out-Null
}

$mcpConfigPath = Join-Path $geminiConfigDir "mcp_config.json"

# 3. 기존 mcp_config.json 로드 혹은 신규 생성
if ((Test-Path $mcpConfigPath) -and ((Get-Item $mcpConfigPath).Length -gt 0)) {
    Write-Host "Loading existing mcp_config.json..." -ForegroundColor Cyan
    $mcpConfig = Get-Content -Raw -Path $mcpConfigPath | ConvertFrom-Json
} else {
    Write-Host "Initializing new mcp_config.json..." -ForegroundColor Yellow
    $mcpConfig = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
}

# mcpServers 객체가 없는 경우 생성
if (-not $mcpConfig.PSObject.Properties['mcpServers']) {
    $mcpConfig | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value [PSCustomObject]@{}
}

# 4. Jira MCP 설정 생성
$jiraServerConfig = [PSCustomObject]@{
    command = "npx"
    args = @("-y", "@modelcontextprotocol/server-jira")
    env = [PSCustomObject]@{
        JIRA_API_TOKEN = $projectConfig.jira_api_token
        JIRA_EMAIL = $projectConfig.jira_email
        JIRA_URL = $projectConfig.jira_url
    }
}

# jira 서버 설정 추가 또는 업데이트
if ($mcpConfig.mcpServers.PSObject.Properties['jira']) {
    Write-Host "Updating existing 'jira' MCP server configuration..." -ForegroundColor Cyan
    $mcpConfig.mcpServers.jira = $jiraServerConfig
} else {
    Write-Host "Adding 'jira' MCP server configuration..." -ForegroundColor Cyan
    $mcpConfig.mcpServers | Add-Member -MemberType NoteProperty -Name "jira" -Value $jiraServerConfig
}

# 5. 설정 파일 저장
Write-Host "Saving updated mcp_config.json to $mcpConfigPath..." -ForegroundColor Yellow
$jsonOutput = $mcpConfig | ConvertTo-Json -Depth 10
$jsonOutput | Set-Content -Path $mcpConfigPath

Write-Host "`n[Success] Jira MCP 설정이 정상적으로 완료되었습니다!" -ForegroundColor Green
Write-Host "이제 Antigravity CLI(agy) 또는 IDE를 재실행하시면 지라 티켓 관련 명령어를 AI가 자동 인지하고 수행합니다.`n" -ForegroundColor Green
