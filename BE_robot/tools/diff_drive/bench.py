#!/usr/bin/env python3
"""ESP32 speed_pid 펌웨어와 대화하는 실험 하네스.

이것이 "자가 학습 루프"의 바닥층이다 — 명령을 넣고 텔레메트리를 되읽어
**사람 없이 스스로 판정**한다. 위에 올라가는 실험(스텝응답·게인탐색·직진시험)은
전부 이 클래스를 쓴다.

    python3 bench.py step            무부하 스텝 응답 (바퀴 띄운 상태)
    python3 bench.py sweep           목표속도 여러 개 훑기
    python3 bench.py tune            Kp/Ki 자동 탐색

🔴 안전: 어떤 실험이든 끝나면 반드시 정지시킨다(finally). 펌웨어 데드맨(1초)이
   2차 방어선이지만, 스크립트가 죽어도 멈추도록 여기서도 보장한다.
"""
import sys
import time

import serial

PORT = "/dev/esp32"
BAUD = 115200


class Bot:
    def __init__(self, port=PORT, baud=BAUD):
        self.ser = serial.Serial(port, baud, timeout=0.1)
        time.sleep(2.0)                      # ESP32 리셋 대기
        self.ser.reset_input_buffer()

    def send(self, line):
        self.ser.write((line + "\n").encode())
        self.ser.flush()

    def stop(self):
        self.send("s")

    def reset_counts(self):
        self.send("r")

    def set_gain(self, key, val):
        self.send(f"k {key} {val}")

    def read_telemetry(self, seconds, target=None, resend_hz=5.0):
        """지정 시간 동안 T 라인을 모은다. target이 있으면 데드맨 때문에 계속 재전송.

        반환: [(t, mode, l_tgt, l_cur, l_duty, r_tgt, r_cur, r_duty, l_cnt, r_cnt), ...]
        """
        rows, t0, next_send = [], time.time(), 0.0
        while time.time() - t0 < seconds:
            if target is not None and time.time() - t0 >= next_send:
                self.send(f"v {target[0]:.4f} {target[1]:.4f}")
                next_send += 1.0 / resend_hz
            raw = self.ser.readline().decode(errors="replace").strip()
            if not raw.startswith("T,"):
                continue
            p = raw.split(",")
            if len(p) != 11:
                continue
            try:
                rows.append((float(p[1]) / 1000.0, int(p[2]),
                             float(p[3]), float(p[4]), float(p[5]),
                             float(p[6]), float(p[7]), float(p[8]),
                             int(p[9]), int(p[10])))
            except ValueError:
                continue
        return rows

    def close(self):
        try:
            self.stop()
            time.sleep(0.2)
        finally:
            self.ser.close()


def _mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def summarize(rows, settle_frac=0.5):
    """뒤쪽 절반만 써서 정상상태를 본다 (앞쪽은 과도응답)."""
    if not rows:
        return None
    k = int(len(rows) * settle_frac)
    tail = rows[k:] or rows
    lt, lc = _mean([r[2] for r in tail]), _mean([r[3] for r in tail])
    rt, rc = _mean([r[5] for r in tail]), _mean([r[6] for r in tail])
    ld, rd = _mean([r[4] for r in tail]), _mean([r[7] for r in tail])
    peak_l = max((r[3] for r in rows), default=0.0)
    return dict(n=len(rows), l_tgt=lt, l_cur=lc, r_tgt=rt, r_cur=rc,
                l_duty=ld, r_duty=rd,
                l_err=lc - lt, r_err=rc - rt,
                imbalance=(lc - rc), peak_l=peak_l)


def cmd_step(bot, target=0.20, secs=4.0):
    print(f"\n=== 스텝 응답  목표 {target} m/s (양쪽) ===")
    bot.reset_counts()
    rows = bot.read_telemetry(secs, target=(target, target))
    bot.stop()
    s = summarize(rows)
    if not s:
        print("  텔레메트리 없음 — 배선/전원 확인")
        return None
    print(f"  샘플 {s['n']}개")
    print(f"  좌  목표{s['l_tgt']:+.3f}  실측{s['l_cur']:+.3f}  "
          f"오차{s['l_err']:+.3f}  duty{s['l_duty']:5.1f}%")
    print(f"  우  목표{s['r_tgt']:+.3f}  실측{s['r_cur']:+.3f}  "
          f"오차{s['r_err']:+.3f}  duty{s['r_duty']:5.1f}%")
    print(f"  좌우 격차 {s['imbalance']*1000:+.1f} mm/s "
          f"({abs(s['imbalance'])/max(target,1e-6)*100:.1f}%)")
    return s


def cmd_sweep(bot, targets=(0.08, 0.12, 0.20, 0.30)):
    print("\n=== 속도 훑기 ===")
    print(f"{'목표':>7} {'좌실측':>8} {'우실측':>8} {'좌duty':>8} "
          f"{'우duty':>8} {'격차%':>7}")
    out = []
    for t in targets:
        bot.reset_counts()
        rows = bot.read_telemetry(3.0, target=(t, t))
        bot.stop()
        time.sleep(0.6)
        s = summarize(rows)
        if not s:
            continue
        out.append((t, s))
        print(f"{t:>7.2f} {s['l_cur']:>8.3f} {s['r_cur']:>8.3f} "
              f"{s['l_duty']:>8.1f} {s['r_duty']:>8.1f} "
              f"{abs(s['imbalance'])/max(t,1e-6)*100:>7.1f}")
    return out


def cmd_tune(bot, target=0.12, secs=2.6,
             kps=(25, 40, 60), kis=(60, 200, 400)):
    """Kp/Ki 격자 탐색 — **바닥(부하)에서** 돌리는 것이 요점이다.

    ⭐ 시험마다 진행 방향을 뒤집는다. 같은 방향으로 9번 달리면 로봇이
       2m 이상 이동해 공간을 벗어난다. 번갈아 가면 제자리 근처에 머문다.

    판정 지표는 '카운트 격차'다 — 속도 오차보다 이게 직진성에 직결된다.
    좌우 카운트가 다르면 그 차이가 곧 회전각(Δ/윤거)이기 때문이다.
    """
    print(f"\n=== 게인 탐색 (부하)  목표 {abs(target)} m/s · 각 {secs}s ===")
    print("   각 게인을 후진·전진 **둘 다** 돌린다 — 한 방향만 재면 방향 효과와")
    print("   게인 효과가 교락되어 어느 쪽이 원인인지 알 수 없다.\n")
    print(f"{'Kp':>5} {'Ki':>5} {'후진gap%':>9} {'전진gap%':>9} "
          f"{'평균|gap|':>10} {'방향차':>8}")
    best = None
    for kp in kps:
        for ki in kis:
            bot.set_gain("p", kp)
            bot.set_gain("i", ki)
            time.sleep(0.2)
            gaps = {}
            for sgn in (-1, +1):             # 후진 → 전진 (제자리 근처 유지)
                bot.reset_counts()
                time.sleep(0.2)
                t = sgn * abs(target)
                rows = bot.read_telemetry(secs, target=(t, t))
                bot.stop()
                time.sleep(0.8)
                if not rows:
                    continue
                lc, rc = abs(rows[-1][8]), abs(rows[-1][9])
                gaps[sgn] = (lc - rc) / max(lc, rc, 1) * 100.0
            if len(gaps) < 2:
                continue
            mean_abs = (abs(gaps[-1]) + abs(gaps[+1])) / 2.0
            mark = ""
            if best is None or mean_abs < best[0]:
                best, mark = (mean_abs, kp, ki), "  <<<"
            print(f"{kp:>5} {ki:>5} {gaps[-1]:>+9.1f} {gaps[+1]:>+9.1f} "
                  f"{mean_abs:>10.1f} {gaps[-1]-gaps[+1]:>+8.1f}{mark}")
    if best:
        print(f"\n  최적: Kp={best[1]} Ki={best[2]} (점수 {best[0]:.2f})")
        bot.set_gain("p", best[1])
        bot.set_gain("i", best[2])
    return best


def cmd_trace(bot, target, secs):
    """텔레메트리 원시 시계열. 좌우가 '언제' 갈라지는지 보려면 이것뿐이다.

    정상상태 요약(summarize)은 평균이라 기동 순간의 차이를 지운다.
    """
    print(f"\n=== 시계열  목표 {target} m/s · {secs}s ===")
    print(f"{'t(s)':>6} {'좌속도':>8} {'우속도':>8} {'좌duty':>7} {'우duty':>7} "
          f"{'좌cnt':>8} {'우cnt':>8} {'cnt차':>7}")
    bot.reset_counts()
    time.sleep(0.2)
    rows = bot.read_telemetry(secs, target=(target, target))
    bot.stop()
    if not rows:
        print("  텔레메트리 없음")
        return
    t0 = rows[0][0]
    for r in rows:
        print(f"{r[0]-t0:>6.2f} {r[3]:>8.3f} {r[6]:>8.3f} {r[4]:>7.1f} "
              f"{r[7]:>7.1f} {r[8]:>8d} {r[9]:>8d} {abs(r[8])-abs(r[9]):>7d}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "step"
    bot = Bot()
    try:
        time.sleep(0.5)
        bot.send("k ?")
        time.sleep(0.3)
        if cmd == "step":
            t = float(sys.argv[2]) if len(sys.argv) > 2 else 0.20
            cmd_step(bot, t)
        elif cmd == "sweep":
            cmd_sweep(bot)
        elif cmd == "tune":
            cmd_tune(bot)
        elif cmd == "trace":
            t = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
            s = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
            cmd_trace(bot, t, s)
        else:
            print(f"알 수 없는 명령: {cmd}")
            return 1
    finally:
        bot.close()          # 🔴 무슨 일이 있어도 정지
    return 0


if __name__ == "__main__":
    sys.exit(main())
