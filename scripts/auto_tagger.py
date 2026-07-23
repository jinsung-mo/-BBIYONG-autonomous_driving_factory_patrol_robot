#!/usr/bin/env python3
"""
Auto Tagger for BBIYONG Team E101
Automates version tagging (SemVer) based on release triggers.

Version model (vMAJOR.MINOR.PATCH):
- PATCH (마지막 버전) : 커밋 단위. dev/통합 브랜치에 새 커밋이 푸시될 때마다 patch +1.
- MINOR (중간 버전)  : 하루 단위. 매일 1회 스케줄러가 그날 누적분을 minor 로 롤업 (+1, patch=0).
- MAJOR (최종 버전)  : main 병합(릴리스) 시 major +1 (minor=patch=0).

트리거는 --type 으로 지정 (CI / 스케줄러가 전달):
- main 병합 CI      -> --type major
- 매일 스케줄 작업   -> --type minor
- 커밋 push CI      -> --type patch
- --type auto (기본) : 브랜치명으로 추론 (main -> major, 그 외 -> patch)
                       (minor 는 시간 기반이라 단일 실행으로 추론 불가 → 반드시 --type minor 로 호출)

변경 없음 처리 (No-change guard):
- 최신 태그 이후 새 커밋이 없으면 태그를 생성하지 않고 건너뜁니다(빈 버전 남발 방지).
  => 하루/일주일 내내 커밋이 없으면 매 실행마다 skip 되고, 새 커밋이 생긴 뒤에야 태그가 찍힙니다.
- 정말로 변경 없이도 강제로 찍어야 하면 --force 사용.
"""

import subprocess, argparse, re

def run_cmd(cmd):
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='ignore')
    return res.stdout.strip()

def get_current_branch():
    branch = run_cmd("git rev-parse --abbrev-ref HEAD")
    if branch == "HEAD" or not branch:
        branch = run_cmd("git name-rev --name-only HEAD")
    return branch

def get_latest_tag():
    run_cmd("git fetch --tags")
    tags = run_cmd("git tag -l 'v*'").splitlines()
    if not tags:
        return "v1.0.0"

    def parse_tag(t):
        m = re.search(r'v?(\d+)\.(\d+)\.(\d+)', t)
        if m:
            return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return (0, 0, 0)

    sorted_tags = sorted(tags, key=parse_tag)
    return sorted_tags[-1]

def has_new_commits_since(tag):
    """최신 태그 이후 HEAD 에 새 커밋이 있는지 여부. 태그가 없으면(최초) 변경 있음으로 간주."""
    exists = run_cmd(f'git rev-parse -q --verify "refs/tags/{tag}^{{commit}}"')
    if not exists:
        return True
    count = run_cmd(f"git rev-list --count {tag}..HEAD")
    try:
        return int(count) > 0
    except ValueError:
        # 계산 실패 시 안전하게 변경 있음으로 처리
        return True

def bump_version(current_tag, bump_type):
    m = re.search(r'v?(\d+)\.(\d+)\.(\d+)', current_tag)
    if not m:
        major, minor, patch = 1, 0, 0
    else:
        major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))

    if bump_type == 'major':
        major += 1
        minor = 0
        patch = 0
    elif bump_type == 'minor':
        minor += 1
        patch = 0
    elif bump_type == 'patch':
        patch += 1

    return f"v{major}.{minor}.{patch}"

def main():
    parser = argparse.ArgumentParser(description="Auto Version Tagger")
    parser.add_argument("--type", choices=["auto", "major", "minor", "patch"], default="auto",
                        help="Bump type. CI/스케줄러가 지정 (auto: 브랜치로 추론)")
    parser.add_argument("--dry-run", action="store_true", help="Print next tag without creating/pushing")
    parser.add_argument("--force", action="store_true", help="변경 사항이 없어도 강제로 태그 생성")
    parser.add_argument("--no-push", action="store_true", help="생성한 태그를 origin 에 푸시하지 않음")
    args = parser.parse_args()

    branch = get_current_branch()
    latest_tag = get_latest_tag()

    bump_type = args.type
    if bump_type == "auto":
        if branch == "main":
            bump_type = "major"
        else:
            bump_type = "patch"

    print(f"Current Branch: {branch}")
    print(f"Latest Tag:     {latest_tag}")

    # --- 변경 없음 처리: 최신 태그 이후 새 커밋이 없으면 skip ---
    if not args.force and not has_new_commits_since(latest_tag):
        print(f"No new commits since {latest_tag}. Skipping tag creation.")
        print("(하루/일주일간 업데이트가 없으면 새 커밋이 생길 때까지 건너뜁니다. 강제 태깅은 --force)")
        return

    new_tag = bump_version(latest_tag, bump_type)
    print(f"Calculated Tag: {new_tag} (Bump: {bump_type})")

    if args.dry_run:
        print("[DRY-RUN] No tag created or pushed.")
        return

    existing_on_commit = run_cmd("git tag --points-at HEAD").splitlines()
    if new_tag in existing_on_commit:
        print(f"Tag {new_tag} already exists on HEAD. Skipping.")
        return

    tag_msg = f"Auto release {new_tag} on {branch}"
    run_cmd(f'git tag -a {new_tag} -m "{tag_msg}"')
    print(f"Successfully created git tag: {new_tag}")

    if not args.no_push:
        run_cmd(f"git push origin {new_tag}")
        print(f"Successfully pushed {new_tag} to origin.")

if __name__ == "__main__":
    main()
