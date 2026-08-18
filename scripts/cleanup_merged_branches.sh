#!/bin/bash
# 이미 머지된 feature/docs/design 브랜치 정리 스크립트

echo "=========================================="
echo "머지된 브랜치 정리 스크립트"
echo "=========================================="
echo ""

# be_robot/main에 머지된 브랜치들
echo "🤖 BE Robot - 머지된 브랜치 삭제 중..."
git push origin --delete feat/S15P11E101-361-drive-trace-log 2>/dev/null && echo "  ✅ feat/S15P11E101-361-drive-trace-log"
git push origin --delete feat/S15P11E101-372-dashboard-heading-up-view 2>/dev/null && echo "  ✅ feat/S15P11E101-372-dashboard-heading-up-view"
git push origin --delete feat/S15P11E101-439-map-send 2>/dev/null && echo "  ✅ feat/S15P11E101-439-map-send"
git push origin --delete feat/S15P11E101-441-nav2-frontier-exploration 2>/dev/null && echo "  ✅ feat/S15P11E101-441-nav2-frontier-exploration"

# ai/main에 머지된 브랜치들
echo ""
echo "🤖 AI - 머지된 브랜치 삭제 중..."
git push origin --delete feat/S15P11E101-227-yolo26s-training-results 2>/dev/null && echo "  ✅ feat/S15P11E101-227-yolo26s-training-results"

# 공통 docs/design 브랜치 (main에 머지되었을 가능성)
echo ""
echo "📚 Docs/Design - 오래된 브랜치 삭제 중..."
git push origin --delete docs/S15P11E101-372-dashboard-ref-for-fe 2>/dev/null && echo "  ✅ docs/S15P11E101-372-dashboard-ref-for-fe"
git push origin --delete docs/S15P11E101-439-fe-nav-map 2>/dev/null && echo "  ✅ docs/S15P11E101-439-fe-nav-map"
git push origin --delete docs/S15P11E101-control-autonomy-arch 2>/dev/null && echo "  ✅ docs/S15P11E101-control-autonomy-arch"
git push origin --delete design/S15P11E101-323-patrol-fire-detect 2>/dev/null && echo "  ✅ design/S15P11E101-323-patrol-fire-detect"

# 오래된 feature 브랜치들 (이미 머지되었을 가능성 높음)
echo ""
echo "🔧 Feature - 오래된 브랜치 삭제 중..."
git push origin --delete feat/S15P11E101-327-be-stomp-integration 2>/dev/null && echo "  ✅ feat/S15P11E101-327-be-stomp-integration"
git push origin --delete feat/S15P11E101-456-gen-mr 2>/dev/null && echo "  ✅ feat/S15P11E101-456-gen-mr"
git push origin --delete feat/S15P11E101-465-fe-manual-drive-key-composition 2>/dev/null && echo "  ✅ feat/S15P11E101-465-fe-manual-drive-key-composition"
git push origin --delete feat/S15P11E101-511-event-delete 2>/dev/null && echo "  ✅ feat/S15P11E101-511-event-delete"
git push origin --delete feat/S15P11E101-512-drive-speed 2>/dev/null && echo "  ✅ feat/S15P11E101-512-drive-speed"

echo ""
echo "=========================================="
echo "✅ 정리 완료"
echo "=========================================="
echo ""
echo "남은 브랜치 확인:"
git branch -r | grep -E "feat/|docs/|design/" | sort
