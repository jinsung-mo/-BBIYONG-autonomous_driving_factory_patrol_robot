#!/usr/bin/env python3
"""부하 기동 데드밴드 측정 (S1) — 좌·우 각각.

duty를 아주 천천히 올리면서 각 바퀴가 **처음 도는 순간**의 duty를 찾는다.
오픈루프(`d` 명령)로 한다 — PID를 끼우면 적분이 데드밴드를 가려버린다.

    python3 deadband.py [최대duty] [단계] [단계당초]
    예) python3 deadband.py 30 1 0.7

왜 필요한가
  무부하 데드밴드 2.24%로 만든 피드포워드는 부하에서 무의미하다.
  0.10 m/s 목표의 FF duty가 7.3%인데 부하 기동은 13% 초과라,
  FF가 있으나 마나 바퀴가 안 돈다 → 적분이 쌓일 때까지 정지 → 먼저 풀린
  쪽이 카운트를 벌어 로봇이 휜다 (실측: 26cm에 7.7° 편향).

안전
  · 한 바퀴만 돌면 로봇이 제자리 피벗한다 — 이동량이 작아 안전하다
  · 양쪽 다 돈 시점에서 즉시 종료
"""
import sys
import time

sys.path.insert(0, "/home/e101/calib")
from bench import Bot          # noqa: E402

MOVE_COUNTS = 25               # 이 이상 변하면 "돌기 시작했다" (잡음 여유)


def main():
    dmax = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    step = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    dwell = float(sys.argv[3]) if len(sys.argv) > 3 else 0.7
    # 방향: +1 전진 / −1 후진. 데드밴드는 방향에 따라 다를 수 있다
    # (기어 백래시·캐스터 자세·바닥 마찰 이방성).
    sgn = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    print(f"방향: {'전진' if sgn > 0 else '후진'}")

    bot = Bot()
    l_start = r_start = None
    try:
        time.sleep(0.5)
        bot.stop()
        time.sleep(0.3)
        bot.reset_counts()
        time.sleep(0.3)

        print(f"{'duty%':>6} {'좌카운트':>10} {'우카운트':>10}   판정")
        base_l = base_r = 0
        for duty in range(step, dmax + 1, step):
            bot.send(f"d {sgn * duty} {sgn * duty}")
            rows = bot.read_telemetry(dwell)
            if not rows:
                continue
            lc, rc = rows[-1][8], rows[-1][9]
            note = []
            if l_start is None and abs(lc - base_l) > MOVE_COUNTS:
                l_start = duty
                note.append("◀ 좌 기동")
            if r_start is None and abs(rc - base_r) > MOVE_COUNTS:
                r_start = duty
                note.append("◀ 우 기동")
            print(f"{duty:>6} {lc:>10} {rc:>10}   {' '.join(note)}")
            base_l, base_r = lc, rc
            if l_start and r_start:
                break
    finally:
        bot.close()

    print()
    if l_start and r_start:
        print(f"  좌 기동 데드밴드 ≈ {l_start}% duty")
        print(f"  우 기동 데드밴드 ≈ {r_start}% duty")
        worse = max(l_start, r_start)
        print(f"\n  → 피드포워드 데드밴드 상수는 **{worse}%** 를 쓴다 (느린 쪽 기준).")
        print(f"     펌웨어에 반영:  k z {worse}")
        if l_start != r_start:
            print(f"  ⚠️ 좌우 {abs(l_start-r_start)}%p 차 — 한쪽이 먼저 풀리는 구간이 "
                  f"존재한다. 이 구간이 직진 편향의 원인이다.")
    else:
        print(f"  {dmax}% 까지 올렸는데 "
              f"{'좌' if not l_start else '우'}가 안 돌았다. 최대duty를 올려 재시도.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
