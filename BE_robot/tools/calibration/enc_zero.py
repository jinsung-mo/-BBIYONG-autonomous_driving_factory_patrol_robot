import serial, time
s = serial.Serial("/dev/esp32", 115200, timeout=1)
time.sleep(0.4); s.write(b"s\n"); time.sleep(0.3)
s.write(b"r\n"); time.sleep(0.6); s.reset_input_buffer(); time.sleep(0.4)
print("리셋됨 → " + s.readline().decode(errors="replace").strip())
print()
print("이제 바퀴를 손으로 천천히 정확히 10회전씩 돌리세요 (좌·우 각각).")
print("끝나면:  ssh orin \"python3 /tmp/enc_read.py\"")
s.close()
