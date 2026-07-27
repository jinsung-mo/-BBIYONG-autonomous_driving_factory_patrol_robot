#!/usr/bin/env python3
"""
Auto Tagger for BBIYONG Team E101
Automates version tagging (SemVer / CalVer) based on branch rules.

Rules:
- main branch -> Major bump (v1.0.0 -> v2.0.0)
- */main branch (be_system/main, fe/main, etc.) -> Minor bump (v1.1.0 -> v1.2.0)
- */dev branch (be_system/dev, fe/dev, etc.) -> Patch bump (v1.1.1 -> v1.1.2)
"""

import subprocess, sys, argparse, re

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
    parser.add_argument("--type", choices=["auto", "major", "minor", "patch"], default="auto", help="Bump type")
    parser.add_argument("--dry-run", action="store_true", help="Print next tag without creating/pushing")
    parser.add_argument("--push", action="store_true", default=True, help="Push tag to origin")
    args = parser.parse_args()

    branch = get_current_branch()
    latest_tag = get_latest_tag()

    bump_type = args.type
    if bump_type == "auto":
        if branch == "main":
            bump_type = "major"
        elif branch.endswith("/main"):
            bump_type = "minor"
        else:
            bump_type = "patch"

    new_tag = bump_version(latest_tag, bump_type)
    print(f"Current Branch: {branch}")
    print(f"Latest Tag:     {latest_tag}")
    print(f"Calculated Tag: {new_tag} (Bump: {bump_type})")

    if args.dry_run:
        print("[DRY-RUN] No tag created or pushed.")
        return

    existing_on_commit = run_cmd("git tag --points-at HEAD")
    if new_tag in existing_on_commit.splitlines():
        print(f"Tag {new_tag} already exists on HEAD.")
        return

    tag_msg = f"Auto release {new_tag} on {branch}"
    run_cmd(f'git tag -a {new_tag} -m "{tag_msg}"')
    print(f"Successfully created git tag: {new_tag}")

    if args.push:
        push_res = run_cmd(f"git push origin {new_tag}")
        print(f"Successfully pushed {new_tag} to origin.")

if __name__ == "__main__":
    main()
