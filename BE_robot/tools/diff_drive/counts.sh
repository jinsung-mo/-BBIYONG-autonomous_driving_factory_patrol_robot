#!/usr/bin/env bash
# 엔코더 카운트만 뽑아 본다. 모터 무동작 — 손으로 돌려도 읽힌다.
#   counts.sh [초]
# 텔레메트리: T,millis,...,left_count,right_count  (11필드, $10=좌 $11=우)
SEC="${1:-15}"
PORT=/dev/esp32
[ -e "$PORT" ] || { echo "🔴 $PORT 없음 — ESP32 미인식"; exit 1; }
stty -F "$PORT" 115200 raw -echo min 0 time 5
echo "── ${SEC}초 관측 시작 · 지금 바퀴를 돌리세요 ──"
timeout "$SEC" cat "$PORT" | awk -F, '
  /^T,/ && NF==11 {
    l = $10 + 0; r = $11 + 0
    n++
    if (n == 1) { l0 = l; r0 = r; lmin = lmax = l; rmin = rmax = r }
    lc = l; rc = r
    if (l < lmin) lmin = l
    if (l > lmax) lmax = l
    if (r < rmin) rmin = r
    if (r > rmax) rmax = r
  }
  END {
    if (n == 0) { print "🔴 텔레메트리 수신 0줄 — 시리얼 확인"; exit }
    printf "샘플 %d줄\n\n", n
    printf "좌  시작 %8d → 끝 %8d   Δ %+8d   진폭 %d\n", l0, lc, lc - l0, lmax - lmin
    printf "우  시작 %8d → 끝 %8d   Δ %+8d   진폭 %d\n\n", r0, rc, rc - r0, rmax - rmin
    if (lmax == lmin) print "🔴 좌 엔코더 — 변화 0. 신호 없음"
    else printf "✅ 좌 엔코더 — 살아 있음 (진폭 %d)\n", lmax - lmin
    if (rmax == rmin) print "🔴 우 엔코더 — 변화 0. 신호 없음"
    else printf "✅ 우 엔코더 — 살아 있음 (진폭 %d)\n", rmax - rmin
  }'
