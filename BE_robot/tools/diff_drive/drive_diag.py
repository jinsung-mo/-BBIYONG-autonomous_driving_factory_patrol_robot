#!/usr/bin/env python3
"""주행로그(trace.csv)로 좌우 구동 이상을 진단한다.

    python3 drive_diag.py [세션디렉터리]      # 생략하면 ~/drivelog 최신 세션

읽는 것
    ~/drivelog/<세션>/trace.csv  —  `arrival_ns,<펌웨어 원문>` 한 줄씩
    펌웨어 T 줄 포맷 (speed_pid.ino:252)
        T, millis, 모드, 좌목표, 좌실측, 좌duty, 우목표, 우실측, 우duty, 좌카운트, 우카운트

무엇을 보는가 — 바퀴마다 독립으로 판정한다
    ① 부호 일치율   목표가 0이 아닐 때 실측이 같은 부호인가
    ② duty 포화율   |duty| 가 상한(80)에 붙어 있는 비율
    ③ 추종비        |실측| / |목표|
    이 셋의 조합이 원인을 가른다. 아래 verdict() 참조.
"""
import os
import sys
import glob

DUTY_MAX = 80.0          # esp32_base_node 가 펌웨어에 보내는 값
SAT = DUTY_MAX * 0.97    # 이 이상이면 포화로 본다
TGT_EPS = 0.01           # 목표가 이보다 작으면 "정지 명령"으로 보고 판정에서 뺀다
MEAS_EPS = 0.005         # 실측이 이보다 작으면 "안 돈다"


def newest_session(root):
    cands = [d for d in glob.glob(os.path.join(root, "*")) if os.path.isdir(d)]
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def load(path):
    """trace.csv → T 줄 리스트 + 이벤트('#') 줄 리스트."""
    rows, events = [], []
    with open(path, encoding="utf-8", errors="replace") as fp:
        for line in fp:
            line = line.rstrip("\n")
            if not line:
                continue
            head, _, rest = line.partition(",")
            if not rest:
                continue
            if rest.startswith("#"):
                events.append(rest)
                continue
            f = rest.split(",")
            # T,millis,mode,lt,lv,ld,rt,rv,rd,lc,rc  → 11 필드
            if len(f) != 11 or f[0] != "T":
                continue
            try:
                rows.append({
                    "ms": int(f[1]), "mode": int(f[2]),
                    "lt": float(f[3]), "lv": float(f[4]), "ld": float(f[5]),
                    "rt": float(f[6]), "rv": float(f[7]), "rd": float(f[8]),
                    "lc": int(f[9]), "rc": int(f[10]),
                })
            except ValueError:
                continue
    return rows, events


def stats(rows, tgt, meas, duty):
    """한 바퀴에 대한 지표. 목표가 실린 구간만 본다."""
    act = [r for r in rows if abs(r[tgt]) > TGT_EPS]
    if not act:
        return None
    n = len(act)
    agree = sum(1 for r in act if r[meas] * r[tgt] > 0)
    stalled = sum(1 for r in act if abs(r[meas]) < MEAS_EPS)
    satur = sum(1 for r in act if abs(r[duty]) >= SAT)
    ratios = [abs(r[meas]) / abs(r[tgt]) for r in act if abs(r[tgt]) > TGT_EPS]
    return {
        "n": n,
        "agree": agree / n,
        "stall": stalled / n,
        "sat": satur / n,
        "ratio": sum(ratios) / len(ratios) if ratios else 0.0,
        "tgt_avg": sum(abs(r[tgt]) for r in act) / n,
        "meas_avg": sum(abs(r[meas]) for r in act) / n,
        "duty_avg": sum(r[duty] for r in act) / n,
        "duty_max": max(abs(r[duty]) for r in act),
        "count_delta": act[-1]["lc" if tgt == "lt" else "rc"]
                       - act[0]["lc" if tgt == "lt" else "rc"],
    }


def verdict(s):
    """지표 조합 → 원인 후보. 확정이 아니라 우선순위다."""
    if s is None:
        return "판정 불가 — 이 바퀴에 목표속도가 실린 구간이 없다 (명령을 안 줬다)"
    out = []
    if s["agree"] < 0.30 and s["sat"] > 0.30:
        out.append(
            "🔴 폐루프 부호 반전 의심 — 실측이 목표와 반대 부호인데 duty 가 상한에 "
            "붙어 있다. PID 가 오차를 키우는 방향으로 밀고 있다(양성 피드백). "
            "모터 배선 극성과 엔코더 A/B 중 **한쪽만** 뒤집힌 상태다"
        )
    if s["stall"] > 0.60 and s["duty_max"] > 20.0:
        out.append(
            "🔴 명령은 나가는데 안 돈다 — duty 를 충분히 주는데 실측이 0이다. "
            "**전기·기계 계통**(모터 전원 M1/M2·MDD10A 출력·권선·기구 구속)"
        )
    if s["stall"] > 0.60 and s["duty_max"] <= 20.0:
        out.append(
            "🔴 PID 가 스스로 duty 를 내렸다 — 실측 0인데 duty 도 안 올린다. "
            "제어기가 '이미 목표에 도달했다'고 믿는다 → **엔코더 오독** 또는 "
            "적분 와인드업 해제 로직"
        )
    if s["agree"] >= 0.70 and 0.7 <= s["ratio"] <= 1.3 and s["sat"] < 0.3:
        out.append("✅ 정상 추종")
    if s["agree"] >= 0.70 and s["ratio"] < 0.7 and s["sat"] > 0.5:
        out.append(
            "⚠️ 포화 — 방향은 맞는데 목표를 못 낸다. duty 상한(80)에 붙었다. "
            "전력·마찰·부하 문제 (기지 이슈: 실측_데이터 §L-5)"
        )
    return "\n      ".join(out) if out else "판정 보류 — 아래 원자료를 보라"


def fmt(name, s):
    if s is None:
        return f"  {name}: 목표 구간 없음"
    return (
        f"  {name}  샘플 {s['n']}\n"
        f"      목표 |avg| {s['tgt_avg']:.3f} m/s   실측 |avg| {s['meas_avg']:.3f} m/s"
        f"   추종비 {s['ratio']:.2f}\n"
        f"      부호일치 {s['agree']*100:5.1f}%   정지비율 {s['stall']*100:5.1f}%"
        f"   duty포화 {s['sat']*100:5.1f}%\n"
        f"      duty avg {s['duty_avg']:+6.1f}  max |{s['duty_max']:.1f}|"
        f"   카운트Δ {s['count_delta']:+d}"
    )


def main():
    root = os.path.expanduser("~/drivelog")
    sess = sys.argv[1] if len(sys.argv) > 1 else newest_session(root)
    if not sess or not os.path.isdir(sess):
        print(f"🔴 세션 없음: {root}")
        print("   esp32_base_node 를 purpose·chassis_id 를 주고 띄워야 기록된다.")
        return 1
    path = os.path.join(sess, "trace.csv")
    if not os.path.exists(path):
        print(f"🔴 {path} 없음")
        return 1

    rows, events = load(path)
    print(f"세션 {sess}")
    print(f"샘플 {len(rows)}줄 · 이벤트 {len(events)}줄")
    if not rows:
        print("🔴 T 줄이 하나도 없다 — 텔레메트리 미수신")
        return 1
    dur = (rows[-1]["ms"] - rows[0]["ms"]) / 1000.0
    print(f"구간 {dur:.1f}초\n")

    L = stats(rows, "lt", "lv", "ld")
    R = stats(rows, "rt", "rv", "rd")

    print("── 지표 ──")
    print(fmt("좌", L))
    print(fmt("우", R))

    print("\n── 판정 ──")
    print(f"  좌: {verdict(L)}")
    print(f"  우: {verdict(R)}")

    # 시계열 — 목표가 실린 구간만, 최대 20줄로 균등 추출
    act = [r for r in rows if abs(r["lt"]) > TGT_EPS or abs(r["rt"]) > TGT_EPS]
    if act:
        print(f"\n── 시계열 (목표 실린 {len(act)}줄 중 균등 20) ──")
        print("     t(s)   좌목표  좌실측  좌duty  |  우목표  우실측  우duty")
        step = max(1, len(act) // 20)
        t0 = act[0]["ms"]
        for r in act[::step][:20]:
            print(f"    {(r['ms']-t0)/1000.0:6.2f}  "
                  f"{r['lt']:+6.3f} {r['lv']:+6.3f} {r['ld']:+6.1f}  |  "
                  f"{r['rt']:+6.3f} {r['rv']:+6.3f} {r['rd']:+6.1f}")

    if events:
        print(f"\n── 이벤트 (마지막 8) ──")
        for e in events[-8:]:
            print(f"    {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
