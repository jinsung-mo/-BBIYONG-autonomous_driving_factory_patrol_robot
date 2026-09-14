import serial, time, re
s = serial.Serial("/dev/esp32", 115200, timeout=1)
time.sleep(0.4); s.reset_input_buffer(); time.sleep(0.5)
line = ""
for _ in range(6):
    ln = s.readline().decode(errors="replace").strip()
    if "L=" in ln: line = ln
s.close()
m = re.search(r"L=\s*(-?\d+).*?R=\s*(-?\d+)", line)
if not m:
    print("읽기 실패: " + line); raise SystemExit(1)
L, R = int(m.group(1)), int(m.group(2))
print(line)
print()
print("  %-6s %10s %12s %12s" % ("", "카운트", "÷10 = CPR", "이론 827 대비"))
for name, v in (("좌", L), ("우", R)):
    cpr = abs(v) / 10.0
    print("  %-6s %10d %12.1f %11.1f%%" % (name, v, cpr, (cpr/827.2-1)*100))
print()
print("  판정 기준:  827 근처 = x4 정상 / 414 근처 = x2 / 207 근처 = x1")
print("  좌우 CPR 차이가 1%% 넘으면 회전수를 잘못 셌을 가능성이 큽니다 (재시도 권장)")
