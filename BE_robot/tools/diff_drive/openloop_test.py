#!/usr/bin/env python3
"""오픈루프 단독 구동 시험 — PID 를 완전히 우회해 모터+드라이버만 본다.

    python3 openloop_test.py

왜 오픈루프인가
    폐루프에서는 "PID 가 이상한 건지, 모터가 이상한 건지"가 안 갈린다.
    `l/m` 은 duty 를 그대로 꽂으므로 **명령한 duty ↔ 실제 회전**만 남는다.

🔴 시리얼을 독점한다. esp32_base_node·teleop_node 를 먼저 내려야 한다
   (base_relog.sh 로 다시 올린다).
🔴 모터가 돈다. 차를 들어 올린 상태에서만 실행할 것.

각 시험 사이에 반드시 `s`(정지)를 넣고, 어떤 경로로 끝나든 마지막에 `s` 를 보낸다.
"""
import sys
import time

import serial

PORT = "/dev/esp32"
BAUD = 115200
SETTLE = 1.2          # 명령 후 속도가 자리잡을 때까지 버리는 시간
HOLD = 2.5            # 계측 구간
REST = 2.0            # 시험 사이 정지 유지

# (라벨, 명령, 기대) — duty 를 두 단계로 줘서 "비례하는가"를 본다
TESTS = [
    ("좌 30%", "l 30"),
    ("좌 60%", "l 60"),
    ("우 30%", "m 30"),
    ("우 60%", "m 60"),
]


def parse_T(line):
    f = line.strip().split(",")
    if len(f) != 11 or f[0] != "T":
        return None
    try:
        return {
            "ms": int(f[1]), "mode": int(f[2]),
            "lt": float(f[3]), "lv": float(f[4]), "ld": float(f[5]),
            "rt": float(f[6]), "rv": float(f[7]), "rd": float(f[8]),
            "lc": int(f[9]), "rc": int(f[10]),
        }
    except ValueError:
        return None


def collect(ser, seconds):
    """seconds 동안 T 줄을 모은다."""
    rows, t_end = [], time.time() + seconds
    while time.time() < t_end:
        try:
            raw = ser.readline().decode(errors="replace")
        except Exception:
            break
        r = parse_T(raw)
        if r:
            rows.append(r)
    return rows


def summarize(label, cmd, rows):
    if not rows:
        print(f"  {label:8s} [{cmd:6s}]  🔴 텔레메트리 0줄")
        return
    n = len(rows)
    lv = sum(r["lv"] for r in rows) / n
    rv = sum(r["rv"] for r in rows) / n
    dlc = rows[-1]["lc"] - rows[0]["lc"]
    drc = rows[-1]["rc"] - rows[0]["rc"]
    ld = sum(r["ld"] for r in rows) / n
    rd = sum(r["rd"] for r in rows) / n
    print(f"  {label:8s} [{cmd:6s}]  n={n:3d}  "
          f"좌 v={lv:+6.3f} duty={ld:+5.1f} Δcnt={dlc:+7d}   "
          f"우 v={rv:+6.3f} duty={rd:+5.1f} Δcnt={drc:+7d}")
    return {"lv": lv, "rv": rv, "dlc": dlc, "drc": drc}


def main():
    try:
        ser = serial.Serial(PORT, BAUD, timeout=0.5)
    except Exception as e:
        print(f"🔴 {PORT} 열기 실패: {e}")
        print("   esp32_base_node 가 아직 물고 있을 수 있다.")
        return 1

    results = {}
    try:
        time.sleep(2.0)                 # 부팅/버퍼 안정
        ser.reset_input_buffer()
        ser.write(b"s\r\n")             # 알려진 상태에서 출발
        time.sleep(1.0)

        print("── 오픈루프 단독 구동 ──")
        print("   (duty 를 그대로 꽂는다. PID 없음)\n")

        for label, cmd in TESTS:
            ser.reset_input_buffer()
            ser.write(f"{cmd}\r\n".encode())
            collect(ser, SETTLE)                     # 과도구간 버림
            rows = collect(ser, HOLD)                # 정상상태 계측
            ser.write(b"s\r\n")
            results[label] = summarize(label, cmd, rows)
            collect(ser, REST)                       # 완전 정지 대기

        print("\n── 판정 ──")
        for side, keys, vk, ck in (
            ("좌", ("좌 30%", "좌 60%"), "lv", "dlc"),
            ("우", ("우 30%", "우 60%"), "rv", "drc"),
        ):
            a, b = results.get(keys[0]), results.get(keys[1])
            if not a or not b:
                print(f"  {side}: 자료 부족")
                continue
            v30, v60 = abs(a[vk]), abs(b[vk])
            if v30 < 0.02 and v60 < 0.02:
                print(f"  {side}: 🔴 **duty 60% 를 줘도 안 돈다** — "
                      f"모터 전원(M1/M2)·MDD10A 출력·권선·기구 구속")
            elif v60 > 1.30:
                print(f"  {side}: 🔴 **duty 를 무시하고 고속** (60%에 {v60:.2f} m/s, "
                      f"무부하 최고 1.73) — PWM 이 안 먹는다. 제어 5핀 의심")
            elif v30 > 0.02 and v60 / max(v30, 1e-6) < 1.3:
                print(f"  {side}: ⚠️ duty 를 2배로 올렸는데 속도가 안 는다 "
                      f"({v30:.2f}→{v60:.2f}) — 포화·전원 부족")
            else:
                print(f"  {side}: ✅ duty 에 비례해 반응 "
                      f"(30%→{v30:.2f}, 60%→{v60:.2f} m/s)")

        # 교차 확인 — 한쪽을 돌릴 때 반대쪽 카운트가 움직이면 배선 교차다
        print("\n── 교차 배선 확인 ──")
        for label, own, other, oname in (
            ("좌 60%", "dlc", "drc", "우"),
            ("우 60%", "drc", "dlc", "좌"),
        ):
            r = results.get(label)
            if not r:
                continue
            if abs(r[other]) > max(50, abs(r[own]) * 0.2):
                print(f"  🔴 {label} 인데 {oname} 카운트가 {r[other]:+d} 움직였다 "
                      f"— 배선/엔코더 교차 의심")
            else:
                print(f"  ✅ {label} 시 {oname} 카운트 {r[other]:+d} (정지)")

    finally:
        try:
            ser.write(b"s\r\n")
            time.sleep(0.3)
            ser.close()
        except Exception:
            pass
        print("\n정지 명령 전송 완료. 포트 반환.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
