import serial, time
s = serial.Serial("/dev/esp32", 115200, timeout=1)
time.sleep(0.4); s.reset_input_buffer()
s.write(b"s\n"); time.sleep(0.3)
s.write(b"r\n"); time.sleep(0.4); s.reset_input_buffer()

end = time.time() + 15
last = 0
samples = []
while time.time() < end:
    s.write(b"f 12\n")               # 양쪽 전진 12%, 데드맨 갱신
    t = time.time() + 3
    while time.time() < t and time.time() < end:
        ln = s.readline().decode(errors="replace").strip()
        if ln:
            samples.append(ln)
            if time.time() - last > 2.5:
                print("  " + ln, flush=True); last = time.time()

s.write(b"s\n"); time.sleep(0.8)
s.reset_input_buffer(); time.sleep(0.5)
fin = s.readline().decode(errors="replace").strip()
print("  [정지] " + fin)
s.write(b"s\n"); s.close()
