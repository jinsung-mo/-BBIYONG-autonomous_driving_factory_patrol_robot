#!/usr/bin/env python3
"""
GitLab API를 사용하여 dev → main MR 생성
"""

import json
import sys
import requests
from requests.auth import HTTPBasicAuth

# GitLab 설정
GITLAB_URL = "https://lab.ssafy.com"
PROJECT_ID = "s15-webmobile3-sub1%2FS15P11E101"  # URL 인코딩된 프로젝트 경로

def load_gitlab_token():
    """GitLab Personal Access Token 로드"""
    # .ai_jira_config.json에서 GitLab 토큰을 찾거나, 별도 파일에서 로드
    # 여기서는 사용자가 환경변수 또는 별도로 제공해야 함
    try:
        import os
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(repo_root, '.gitlab_token'), 'r') as f:
            return f.read().strip()
    except:
        print("⚠️  GitLab Personal Access Token이 필요합니다.")
        print("   ~/.gitlab_token 파일에 토큰을 저장하거나")
        print("   GITLAB_TOKEN 환경변수를 설정해주세요.")
        print()
        print("   토큰 생성: https://lab.ssafy.com/-/user_settings/personal_access_tokens")
        print("   필요 권한: api, write_repository")
        sys.exit(1)

def create_mr(token, source_branch, target_branch, title, description):
    """GitLab MR 생성"""
    url = f"{GITLAB_URL}/api/v4/projects/{PROJECT_ID}/merge_requests"

    headers = {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json"
    }

    payload = {
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": title,
        "description": description,
        "remove_source_branch": False  # dev 브랜치는 유지
    }

    response = requests.post(url, headers=headers, json=payload)

    if response.status_code == 201:
        mr_data = response.json()
        print(f"✅ MR 생성 완료: {mr_data['web_url']}")
        return mr_data
    else:
        print(f"❌ MR 생성 실패 ({source_branch} → {target_branch})")
        print(f"   Status: {response.status_code}")
        print(f"   Response: {response.text}")
        return None

def main():
    token = load_gitlab_token()

    print("=" * 80)
    print("GitLab MR 자동 생성")
    print("=" * 80)
    print()

    # BE System MR
    be_system_desc = """## Summary
- 카메라 상하 각도(CAMERA_TILT) 명령 계약 및 STOMP 중계
- 순찰 경로 중심 API 퍼사드 (/api/patrol-route)
- 도면 정제를 OpenCV(bytedeco)로 교체 (품질 향상)
- 매핑 완료 시 2D 도면 자동 생성 (occupancy grid 정제 → floor plan)
- 로봇/게이트웨이 업로드 인증 (X-Robot-Token)
- 순찰 지점(waypoint) 저장·조회 API + 로봇 경로 하달
- 온디맨드 매핑 STOP/완료 relay + 활성 맵 API
- 로봇 연결상태 정확화(가짜 프리로드 제거·끊김 반영·timeout)
- 설비 임계값 로봇 반영(SET_THRESHOLD)
- 회원가입 필수 정보 확장 및 비밀번호 정책 강화

## Test plan
- [x] 백엔드 서버 빌드 및 테스트 통과 확인
- [x] API 엔드포인트 동작 검증
- [x] STOMP 메시지 중계 정상 동작 확인
- [x] 로봇 연결 상태 모니터링 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
"""

    # BE Robot MR
    be_robot_desc = """## Summary
- 직진성 분석 도구 (좌우 편차·헤딩 편향)
- 수동 조종 감속 램프 — 손 뗄 때 급제동 제거
- 수동 조종 속도 상한 1.0 m/s · 가속 램프 · 가드 방위 표시
- Nav2 안전 프론티어 자율 매핑 구현
- BE_robot 배선·진단 진입점 README 작성
- 구동계 진단 도구 추가 (오픈루프 시험·주행로그 분석)
- 모터 출력 좌우 교차를 펌웨어 핀 정의로 보정
- 관제서버 연동 WS 브리지 추가 (파일 기반 1단계)
- LiDAR filtering and Nav2 safety layers
- 대시보드 맵 로봇 중심 진행방향-위 렌더링

## Test plan
- [x] ROS2 패키지 빌드 확인
- [x] Nav2 자율주행 동작 검증
- [x] 텔레옵 제어 정상 동작 확인
- [x] 센서 데이터 파이프라인 검증

🤖 Generated with [Claude Code](https://claude.com/claude-code)
"""

    # FE MR
    fe_desc = """## Summary
- 설비별 과열 임계 온도 조회·수정 연동
- 정제 2D 도면 자동 표시 (FLOORPLAN_READY)
- 전면 카메라 상하 각도 조작 UI
- 이벤트 로그 삭제 기능 — 더미/테스트 이벤트 정리
- 주행 속도 상한 서버 연동 — GET/PUT drive-speed
- 2D 지도 클릭으로 순찰 지점 생성·삭제·저장·하달
- WASD 키 입력 시 모드 전환 방지 (스페이스바만 모드 전환)
- 연동 레이어 보강 — /topic/mapping · 로봇 online · realBackend 플래그

## Test plan
- [x] 프론트엔드 빌드 확인
- [x] UI 컴포넌트 렌더링 검증
- [x] WebSocket 실시간 연동 확인
- [x] 사용자 인터랙션 동작 검증

🤖 Generated with [Claude Code](https://claude.com/claude-code)
"""

    mrs = [
        {
            "source": "be_system/dev",
            "target": "be_system/main",
            "title": "[Merge] be_system/dev → be_system/main",
            "description": be_system_desc
        },
        {
            "source": "be_robot/dev",
            "target": "be_robot/main",
            "title": "[Merge] be_robot/dev → be_robot/main",
            "description": be_robot_desc
        },
        {
            "source": "fe/dev",
            "target": "fe/main",
            "title": "[Merge] fe/dev → fe/main",
            "description": fe_desc
        }
    ]

    results = []
    for mr in mrs:
        print(f"Creating MR: {mr['source']} → {mr['target']}")
        result = create_mr(token, mr['source'], mr['target'], mr['title'], mr['description'])
        results.append(result)
        print()

    print("=" * 80)
    print("MR 생성 완료")
    print("=" * 80)
    print()

    for i, result in enumerate(results):
        if result:
            print(f"{i+1}. {result['web_url']}")

if __name__ == "__main__":
    main()
