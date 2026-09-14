import serial, time, re, sys

DUR = int(sys.argv[1]) if len(sys.argv) > 1 else 90
s = serial.Serial("/dev/esp32", 115200, timeout=1)
time.sleep(0.4); s.write(b"s\n"); time.sleep(0.3)
s.write(b"r\n"); time.sleep(0.6); s.reset_input_buffer()

print("리셋 완료. 지금부터 %d초 기록합니다." % DUR)
print("한 바퀴 돌리고 → 2초 정지 → 한 바퀴 → 2초 정지 … 반복하세요.")
print("(좌·우 아무 바퀴나. 정지 구간으로 자동 분리합니다)")
print()

samples = []
t0 = time.time()
while time.time() - t0 < DUR:
    ln = s.readline().decode(errors="replace").strip()
    m = re.search(r"L=\s*(-?\d+).*?R=\s*(-?\d+)", ln)
    if m:
        samples.append((time.time() - t0, int(m.group(1)), int(m.group(2))))
s.write(b"s\n"); s.close()

def segment(idx, label):
    # 1.2초 이상 변화 없으면 정지로 간주 → 구간 분리
    vals = [(t, v[idx]) for t, v in ((x[0], x[1:]) for x in samples)]
    segs, cur_start, last_change_t, last_v = [], None, vals[0][0], vals[0][1]
    for t, v in vals:
        if v != last_v:
            if cur_start is None:
                cur_start = last_v
            last_change_t = t; last_v = v
        elif cur_start is not None and t - last_change_t > 1.2:
            segs.append(abs(v - cur_start)); cur_start = None
    if cur_start is not None:
        segs.append(abs(vals[-1][1] - cur_start))
    segs = [x for x in segs if x > 50]
    if not segs:
        print("  %s: 회전 구간 없음" % label); return
    avg = sum(segs) / len(segs)
    print("  %s  구간 %d개" % (label, len(segs)))
    print("    " + "  ".join("%d" % x for x in segs))
    print("    평균 %.1f  최소 %d  최대 %d  산포 %.1f%%"
          % (avg, min(segs), max(segs), (max(segs)-min(segs))/avg*100))

print("=== 결과 ===")
segment(0, "좌")
segment(1, "우")
print()
print("  827 근처 = x4 / 414 근처 = x2 / 207 근처 = x1")
