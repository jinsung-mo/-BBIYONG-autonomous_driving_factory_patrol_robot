// OrinCar — 모터 구동 + 엔코더 검증 v2 (하드웨어 PCNT + 글리치 필터)
// 엔코더: 좌 GPIO32/33, 우 GPIO25/26 | MDD10A: PWM1=18 DIR1=19 PWM2=23 DIR2=13
// 시리얼 명령: f 20 = 전진 20% | b 20 = 후진 20% | s = 정지 | r = 카운트 리셋
//             l 15 / l -15 = 왼쪽만 정/역 15% | m 15 / m -15 = 오른쪽만
// 안전장치: 5초간 명령 없으면 자동 정지 (duty 상한은 부하테스트 위해 100%로 해제)
// v2: 소프트웨어 인터럽트 → PCNT 하드웨어 x4 쿼드러처. 글리치 필터 최대(~12.7µs)
//     바퀴 1회전 기준 카운트: 414(x2) → 827(x4)

#include <ESP32Encoder.h>

constexpr int L_A = 32, L_B = 33, R_A = 25, R_B = 26;
constexpr int PWM1 = 18, DIR1 = 19, PWM2 = 23, DIR2 = 13;
constexpr int MAX_PCT = 100;

ESP32Encoder encL, encR;
unsigned long lastCmdMs = 0;
int curPct = 0;

void driveOne(int pwmPin, int dirPin, int pct, bool fwd) {
  pct = constrain(pct, 0, MAX_PCT);
  digitalWrite(dirPin, fwd);
  ledcWrite(pwmPin, (uint32_t)pct * 1023 / 100);
}

void drive(int pct, bool fwd) {           // pct 0~40, 양쪽
  driveOne(PWM1, DIR1, pct, fwd);
  driveOne(PWM2, DIR2, pct, fwd);
  curPct = fwd ? pct : -pct;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  ESP32Encoder::useInternalWeakPullResistors = puType::up;
  encL.attachFullQuad(L_A, L_B);
  encR.attachFullQuad(R_A, R_B);
  encL.setFilter(1023);                   // 12.7µs 미만 펄스 무시 (하드웨어)
  encR.setFilter(1023);
  encL.clearCount(); encR.clearCount();
  pinMode(DIR1, OUTPUT); pinMode(DIR2, OUTPUT);
  ledcAttach(PWM1, 20000, 10);            // 20kHz, 10bit — MDD10A 상한
  ledcAttach(PWM2, 20000, 10);
  drive(0, true);
  Serial.println("=== drive+encoder v2 (PCNT) === f/b/l/m <pct>, s, r");
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'f' || c == 'b') { drive(Serial.parseInt(), c == 'f'); lastCmdMs = millis(); }
    else if (c == 'l') {                  // 왼쪽만, 부호로 방향
      int p = Serial.parseInt();
      driveOne(PWM1, DIR1, abs(p), p >= 0);
      driveOne(PWM2, DIR2, 0, true);
      curPct = p; lastCmdMs = millis();
    }
    else if (c == 'm') {                  // 오른쪽만
      int p = Serial.parseInt();
      driveOne(PWM2, DIR2, abs(p), p >= 0);
      driveOne(PWM1, DIR1, 0, true);
      curPct = p; lastCmdMs = millis();
    }
    else if (c == 'd') {                  // 양쪽 독립: d 30 -30 (좌 정방향, 우 역방향)
      int pl = Serial.parseInt();
      int pr = Serial.parseInt();
      driveOne(PWM1, DIR1, abs(pl), pl >= 0);
      driveOne(PWM2, DIR2, abs(pr), pr >= 0);
      curPct = pl ? pl : pr; lastCmdMs = millis();
    }
    else if (c == 's') drive(0, true);
    else if (c == 'r') { encL.clearCount(); encR.clearCount(); }
  }
  if (curPct != 0 && millis() - lastCmdMs > 5000) {   // 데드맨
    drive(0, true);
    Serial.println("[auto-stop]");
  }
  Serial.printf("duty=%3d%%  L=%7ld [A%d B%d]  R=%7ld [A%d B%d]\n", curPct,
                (long)encL.getCount(), digitalRead(L_A), digitalRead(L_B),
                (long)encR.getCount(), digitalRead(R_A), digitalRead(R_B));
  delay(200);
}
