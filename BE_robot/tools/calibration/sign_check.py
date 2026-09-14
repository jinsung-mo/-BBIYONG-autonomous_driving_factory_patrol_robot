import serial, time
s = serial.Serial("/dev/esp32", 115200, timeout=1)
time.sleep(0.4); s.reset_input_buffer()
s.write(b"s\n"); time.sleep(0.3)
s.write(b"r\n"); time.sleep(0.4); s.reset_input_buffer()

print("=== d 15 -15  (좌 정방향 / 우 역방향) ===", flush=True)
end = time.time() + 5
while time.time() < end:
    s.write(b"d 15 -15\n")
    t = time.time() + 2.5
    while time.time() < t and time.time() < end:
        s.readline()
s.write(b"s\n"); time.sleep(0.8); s.reset_input_buffer(); time.sleep(0.4)
print("  " + s.readline().decode(errors="replace").strip(), flush=True)

time.sleep(0.5)
s.write(b"r\n"); time.sleep(0.4); s.reset_input_buffer()
print("=== d -15 15  (반대) ===", flush=True)
end = time.time() + 5
while time.time() < end:
    s.write(b"d -15 15\n")
    t = time.time() + 2.5
    while time.time() < t and time.time() < end:
        s.readline()
s.write(b"s\n"); time.sleep(0.8); s.reset_input_buffer(); time.sleep(0.4)
print("  " + s.readline().decode(errors="replace").strip(), flush=True)
s.write(b"s\n"); s.close()
