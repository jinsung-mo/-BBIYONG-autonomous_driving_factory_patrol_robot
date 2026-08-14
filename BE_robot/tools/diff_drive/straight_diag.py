#!/usr/bin/env python3
"""직진 주행의 좌우 편차를 전진/후진으로 나눠 분석한다.

    python3 straight_diag.py [세션디렉터리]     # 생략하면 ~/drivelog 최신

읽는 것: ~/drivelog/<세션>/trace.csv
    `arrival_ns,` + 펌웨어 원문
    T, millis, 모드, 좌목표, 좌실측, 좌duty, 우목표, 우실측, 우duty, 좌카운트, 우카운트

무엇을 보는가 — 이 셋의 조합이 원인을 가른다
    ① 속도 편차   좌우 실측속도가 얼마나 다른가          → 결과
    ② duty 편차   좌우 duty 가 얼마나 다른가             → 제어기가 보정 중인가
    ③ duty 포화   상한(80)에 붙어 있는 비율              → 보정할 여유가 있는가

    🔑 속도가 같은데 duty 가 다르면 **폐루프가 정상 작동 중**이다.
       모터 특성차를 duty 로 흡수하고 있다는 뜻이라 고칠 게 없다.
"""
import glob
import math
import os
import sys

MM_PER_COUNT = 0.16348      # [실측] §J-2
TRACK_M = 0.2091            # [실측] §K
DUTY_MAX = 80.0
SAT = DUTY_MAX * 0.97
TGT_EPS = 0.01              # 목표가 이보다 작으면 정지 명령으로 본다
STRAIGHT_EPS = 0.02         # 좌우 목표차가 이보다 크면 회전 명령 — 직진 분석에서 뺀다
GAP_MS = 300                # 샘플 간격이 이보다 벌어지면 다른 주행으로 본다
                            # (텔레메트리 10Hz = 100ms 이므로 3틱 이상 빈 것)

# 🔴 §L-4 기준선 — **직접 비교하지 마라.**
#    2026-07-27 측정 당시 조건: ① 차체 12.5mm 앞기울기 ② duty_max 80% 포화.
#    2026-07-29 재조립에서 전방 바퀴 높이를 고쳐 **차체가 수평이 됐다** →
#    기울기에서 오던 편향 성분이 사라졌으므로 이 값은 더 이상 같은 차의 값이 아니다.
#    참고 표시만 하고, 새 기준선은 수평 상태에서 다시 잡아야 한다.
BASELINE = {"전진": +10.13, "후진": -20.69}


def newest_session(root):
    dirs = [d for d in glob.glob(os.path.join(root, "*")) if os.path.isdir(d)]
    return max(dirs, key=os.path.getmtime) if dirs else None


def load(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as fp:
        for line in fp:
            _, _, rest = line.rstrip("\n").partition(",")
            f = rest.split(",")
            if len(f) != 11 or f[0] != "T":
                continue
            try:
                rows.append({
                    "ms": int(f[1]),
                    "lt": float(f[3]), "lv": float(f[4]), "ld": float(f[5]),
                    "rt": float(f[6]), "rv": float(f[7]), "rd": float(f[8]),
                    "lc": int(f[9]), "rc": int(f[10]),
                })
            except ValueError:
                continue
    return rows


def segments(rows):
    """직진 구간만 뽑아 전진/후진으로 나눈다.

    좌우 목표가 거의 같아야 직진이다 — 회전 명령이 섞이면 좌우 편차 분석이 무의미하다.
    """
    fwd, rev = [], []
    for r in rows:
        if abs(r["lt"]) < TGT_EPS and abs(r["rt"]) < TGT_EPS:
            continue                                   # 정지
        if abs(r["lt"] - r["rt"]) > STRAIGHT_EPS:
            continue                                   # 회전 성분 있음
        (fwd if r["lt"] > 0 else rev).append(r)
    return fwd, rev


def analyse(name, seg):
    if len(seg) < 5:
        print(f"\n── {name} ──\n  자료 부족 ({len(seg)}줄). 그 방향으로 안 달렸다.")
        return
    n = len(seg)
    lv = sum(r["lv"] for r in seg) / n
    rv = sum(r["rv"] for r in seg) / n
    ld = sum(r["ld"] for r in seg) / n
    rd = sum(r["rd"] for r in seg) / n
    sat_l = sum(1 for r in seg if abs(r["ld"]) >= SAT) / n
    sat_r = sum(1 for r in seg if abs(r["rd"]) >= SAT) / n
    tgt = sum(abs(r["lt"]) for r in seg) / n

    # 🔴 거리는 **연속 구간(run)마다** 재야 한다.
    #    seg 는 시간상 이어져 있지 않다 — 전진 구간 사이에 회전·후진·정지가 끼어 있고,
    #    카운트는 누적값이라 첫 샘플과 마지막 샘플의 차이를 쓰면 그 사이 **다른 방향
    #    이동까지 전부 더해진다**. 실제로 3.8초 후진이 15.96m 로 찍혔다 (2026-07-29).
    runs, cur = [], [seg[0]]
    for prev, r in zip(seg, seg[1:]):
        if r["ms"] - prev["ms"] > GAP_MS:      # 끊겼다 → 새 run
            runs.append(cur)
            cur = [r]
        else:
            cur.append(r)
    runs.append(cur)
    runs = [q for q in runs if len(q) >= 3]    # 너무 짧은 조각은 버린다
    if not runs:
        print(f"\n── {name} ──\n  연속 구간 없음 (조각 {len(seg)}샘플). 더 길게 눌러야 한다.")
        return
    dist_l = sum((q[-1]["lc"] - q[0]["lc"]) for q in runs) * MM_PER_COUNT / 1000.0
    dist_r = sum((q[-1]["rc"] - q[0]["rc"]) for q in runs) * MM_PER_COUNT / 1000.0
    mean_d = (abs(dist_l) + abs(dist_r)) / 2.0

    # 좌우 거리차 → 헤딩 변화. 직진이면 0 이어야 한다.
    d_theta = (dist_l - dist_r) / TRACK_M              # rad
    deg_per_m = math.degrees(d_theta) / mean_d if mean_d > 0.05 else float("nan")

    ref = abs(lv) if abs(lv) > abs(rv) else abs(rv)
    v_gap = abs(lv - rv) / ref * 100 if ref > 1e-6 else 0.0
    d_gap = abs(ld) - abs(rd)

    print(f"\n── {name} ──   샘플 {n}  ·  목표 {tgt:.3f} m/s  ·  주행 {mean_d:.2f} m")
    print(f"  속도   좌 {lv:+6.3f}   우 {rv:+6.3f}   편차 {v_gap:5.1f}%")
    print(f"  duty   좌 {ld:+6.1f}   우 {rd:+6.1f}   차   {d_gap:+5.1f}p"
          f"   포화 좌{sat_l*100:4.0f}% 우{sat_r*100:4.0f}%")
    print(f"  거리   좌 {dist_l:+6.3f}m 우 {dist_r:+6.3f}m  차 {dist_l-dist_r:+6.3f}m")
    print(f"  ⭐ 헤딩 편향  {deg_per_m:+7.2f} deg/m"
          f"   (기준선 {BASELINE.get(name, float('nan')):+.2f})")

    # ── 판정 ──
    saturated = max(sat_l, sat_r) > 0.30
    if v_gap < 3.0 and not saturated:
        print("  ✅ 폐루프 정상 — 속도가 맞고 duty 여유도 있다.")
        if abs(d_gap) > 5.0:
            print(f"     (duty 차 {d_gap:+.1f}p 는 모터 특성차를 흡수 중이라는 뜻. 정상)")
        if abs(deg_per_m) > 3.0:
            print(f"  ⚠️ 그런데 헤딩은 {deg_per_m:+.1f} deg/m 로 휜다 —")
            print("     속도는 맞는데 휜다면 **바퀴지름 좌우차·바닥 경사·캐스터**다. 제어 문제가 아니다.")
    elif saturated:
        print(f"  🔴 **duty 포화** (좌{sat_l*100:.0f}% 우{sat_r*100:.0f}%) — 제어기에 보정 권한이 없다.")
        print("     게인을 만져도 소용없다. 목표속도를 낮추거나 전력·마찰을 먼저 본다.")
    else:
        print(f"  🔴 **속도 편차 {v_gap:.1f}%** 인데 duty 여유가 있다 — 제어기가 못 따라잡는다.")
        print("     PID 게인(kp/ki) 또는 방향별 피드포워드(ff_dead) 후보.")


def main():
    root = os.path.expanduser("~/drivelog")
    sess = sys.argv[1] if len(sys.argv) > 1 else newest_session(root)
    if not sess or not os.path.isdir(sess):
        print(f"🔴 세션 없음: {root}")
        return 1
    rows = load(os.path.join(sess, "trace.csv"))
    print(f"세션 {sess}\n샘플 {len(rows)}줄")
    if not rows:
        print("🔴 T 줄 0개")
        return 1

    fwd, rev = segments(rows)
    print(f"직진 구간  전진 {len(fwd)}줄 · 후진 {len(rev)}줄"
          f"  (회전·정지 제외)")
    analyse("전진", fwd)
    analyse("후진", rev)

    if len(fwd) >= 5 and len(rev) >= 5:
        print("\n── 전·후진 대조 ──")
        print("  같은 방향으로만 휘면 기구(바퀴지름·정렬), 부호가 뒤집히면 바닥 경사다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
