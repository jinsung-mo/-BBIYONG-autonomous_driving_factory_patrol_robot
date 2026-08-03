// OrinCar — 바퀴 속도 PID 펌웨어 v1  (S2)
// ============================================================================
// drive_test.ino(오픈루프)의 상위 호환. 기존 f/b/l/m/d/s/r 명령을 그대로 유지하므로
// S1 측정 스크립트는 수정 없이 계속 동작한다.
//
// 핵심 추가: `v <좌 m/s> <우 m/s>` — 바퀴별 목표속도를 폐루프로 추종한다.
//
// 🔒 부호 규약 (이 펌웨어가 흡수한다 — docs/실측_데이터.md §D)
//   물리 실측: 전진 시 좌 엔코더 +, 우 엔코더 −  (좌우 모터가 거울 대칭 장착)
//   → 이 펌웨어 **바깥**에서는 그 사실이 보이지 않는다. 양쪽 다 + = 전진이다.
//     · 명령:   v 0.2 0.2  → 차체 전진
//     · 텔레메트리: 전진 중 좌·우 속도가 **둘 다 양수**로 보고된다
//   ⚠️ 따라서 ROS 쪽 `right_wheel_direction`은 반드시 **+1**이어야 한다.
//      −1을 주면 이중 반전이 되어 제자리 회전한다.
//
// 제어 구조: 피드포워드 + PI
//   duty = FF(목표속도) + Kp·오차 + Ki·∫오차
//   FF가 없으면 적분항이 부하 데드밴드(>13% duty)를 넘길 때까지 로봇이 멈춰 있다가
//   갑자기 튀어나간다. FF가 대략을 맞추고 PI는 좌우 격차만 잡는다.
//   그 격차가 §L에서 관측된 23.8% → 39.1%(시간에 따라 변함)이며, 이것이 PID를
//   "있으면 좋은 것"이 아니라 **필수**로 만든 이유다.
//
// 🔴 FF 상수는 전부 **무부하** 실측값이다(§E-4). 부하에서는 틀린다.
//    그래서 전 상수를 `k` 명령으로 런타임 조정 가능하게 했다 —
//    S1(부하 duty–속도 곡선)을 나중에 재도 **재플래시 없이** 반영된다.
// ============================================================================
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  #define PU_UP puType::up
  #define INIT_PWM(pin, ch, hz, bits) ledcAttach(pin, hz, bits)
  #define SET_PWM(pin, ch, val) ledcWrite(pin, val)
#else
  #define PU_UP UP
  #define INIT_PWM(pin, ch, hz, bits) do { ledcSetup(ch, hz, bits); ledcAttachPin(pin, ch); } while(0)
  #define SET_PWM(pin, ch, val) ledcWrite(ch, val)
#endif
#include <ESP32Encoder.h>
#include <Wire.h>
#include <Adafruit_MLX90640.h>
#include <DHT.h>

Adafruit_MLX90640 mlx;
bool mlx_ok = false;
unsigned long lastMlxMs = 0;
float mlxFrame[32*24];

// ---------- 핀 (docs/실측_데이터.md §A) ----------
constexpr int L_A = 32, L_B = 33, R_A = 25, R_B = 26;
// 🔴 [실측 2026-08-03 · S15P11E101-651] 2026-07-29 의 교차 보정을 **원복**했다.
//    그때 주석이 예고한 그대로다 — "배선을 바로잡으면 이 교차를 원복할 것".
//    그 사이 배선이 물리적으로 고쳐졌는데 보정이 남아 있어, 이번엔 **펌웨어가**
//    교차의 원인이 돼 있었다(제어기가 A 모터에 명령하고 B 바퀴를 측정 → PI 발산).
//
//    실측 절차: 오픈루프로 한 채널씩 걸고 사용자가 어느 바퀴가 도는지 육안 확인
//    (tools/diff_drive/wheel_identify.py). 결과:
//      · GPIO18/19 → 물리 **좌** 바퀴 · DIR LOW 에서 **전진** · encL 이 **+**
//      · GPIO23/13 → 물리 **우** 바퀴 · DIR LOW 에서 **전진** · encR 이 **−**
//    ⚠️ 배선을 다시 만지면 이 표를 반드시 다시 재라. 보정을 쌓지 말고 이 표를 고쳐라.
constexpr int PWM1 = 18, DIR1 = 19;      // 좌 = 물리 좌측 모터
constexpr int PWM2 = 23, DIR2 = 13;      // 우 = 물리 우측 모터

// ---------- 확정 상수 ----------
constexpr float MM_PER_COUNT = 0.16348f; // [실측] §J-2
constexpr int   PWM_HZ = 20000, PWM_BITS = 10;   // MDD10A 상한
constexpr int   PWM_MAX = (1 << PWM_BITS) - 1;
constexpr uint32_t CTRL_HZ = 50;                 // 0.3m/s에서 20ms당 37카운트
constexpr uint32_t CTRL_MS = 1000 / CTRL_HZ;

// ---------- 서보모터 ----------
constexpr int SERVO_PIN = 4;
constexpr int SERVO_CH = 2;

// ---------- 런타임 조정 상수 (`k` 명령) ----------
struct Tunables {
  float kp        = 25.0f;   // %duty per (m/s)   — FF 역기울기 51의 절반에서 시작
  float ki        = 60.0f;   // %duty per (m/s·s)
  float ff_slope  = 0.0196f; // m/s per %duty     [실측 무부하] §E-4
  float ff_dead   = 2.24f;   // %duty 데드밴드    [실측 무부하] §E-4
                             // 🔴 부하는 >13% (§L-2, 정확값 미측정)
  float i_limit   = 40.0f;   // 적분 기여 상한 %duty (와인드업 방지)
  float duty_max  = 80.0f;   // 속도모드 duty 상한
  float v_alpha   = 0.30f;   // 속도 EMA 계수 (양자화 잡음 억제)
} tun;

// ---------- 상태 ----------
ESP32Encoder encL, encR;

struct Wheel {
  int64_t prev_count = 0;
  float   v = 0.0f;          // 정규화 속도 m/s (+ = 전진)
  float   target = 0.0f;
  float   integ = 0.0f;
  float   duty = 0.0f;       // 정규화 duty % (+ = 전진)
} wl, wr;

enum Mode { MODE_IDLE, MODE_OPENLOOP, MODE_VELOCITY };
Mode mode = MODE_IDLE;

unsigned long lastCmdMs = 0, lastCtrlMs = 0, lastTeleMs = 0;
uint32_t deadman_ms = 1000;      // 속도모드 기본 1초 (ROS가 20Hz로 보낸다)
uint32_t tele_ms = 50;           // 텔레메트리 20Hz (2026-07-30: teleop 소비주기(20Hz)에 맞춤 — 종전 10Hz)
bool tele_csv = true;            // true=기계 파싱용 CSV, false=사람용

// ---------- DHT11(온습도) + INA226(배터리 전압) — 2026-08-03 초안 ----------
// 🔴 둘 다 저빈도(1Hz) 전용이다. PID 루프(CTRL_HZ=50)는 절대 이 센서들을 기다리지 않는다 —
//    loop() 맨 끝, 명령 파싱/제어/텔레메트리보다 낮은 우선순위에서만 읽는다.
//    (MLX90640을 ESP32에서 빼고 Orin 직결로 간 것과 같은 이유 — 블로킹 최소화. §B-4)
//    INA226은 MLX90640(Wire, GPIO21/22)과 별도 I2C 버스(GPIO14/27)라 버스 경합도 없다.
// 🔴 이 블록은 struct Wheel 정의(위) *다음*에 와야 한다 — Arduino .ino→.cpp 변환기가
//    자동생성 함수 프로토타입을 "파일 내 첫 함수 정의" 지점에 통째로 삽입하는데,
//    이 블록이 더 위(제일 앞 #include 직후)에 있으면 inaReadBusVoltage()가 그 "첫 함수"가
//    되어 controlWheel(Wheel&, ...) 프로토타입이 struct Wheel보다 먼저 삽입돼 컴파일 에러가 난다.
//    (agy gemini-3.1-pro-high 검토 완료, 2026-08-03 — Option A 채택)
constexpr int DHT_PIN = 15;
DHT dht(DHT_PIN, DHT11);
bool  dht_ok = false;              // 마지막 읽기 성공 여부. 실패해도 이전 값은 유지(래치)
float dhtTempC = 0.0f, dhtHumidity = 0.0f;
unsigned long lastEnvMs = 0;
constexpr uint32_t ENV_MS = 1000;  // DHT11 하드웨어 하한(≥1s) 준수 — INA226도 여기 묶어서 1Hz

constexpr uint8_t INA226_ADDR           = 0x40;
constexpr uint8_t INA226_REG_BUSVOLTAGE = 0x02;
TwoWire WireIna(1);                // 전용 2번째 I2C 버스 (SDA=GPIO14, SCL=GPIO27) — Wire(21/22)와 분리
bool  ina_present = false;         // setup()에서 1회 프로브 (디바이스 자체가 없는 경우)
bool  ina_ok = false;              // 마지막 읽기 성공 여부(통신 실패). "0V 근처" 정상값과는 별개 개념
float inaVoltage = 0.0f;           // V. 실패 시 이전 값 유지(래치)

bool inaReadBusVoltage(float &volts) {
  WireIna.beginTransmission(INA226_ADDR);
  WireIna.write(INA226_REG_BUSVOLTAGE);
  if (WireIna.endTransmission(false) != 0) return false;   // NACK = 응답 없음(배선불량/미장착)
  if (WireIna.requestFrom((int)INA226_ADDR, 2) != 2) return false;
  // 🔴 (a<<8)|b 형태로 한 줄에 read()를 두 번 쓰면 평가 순서가 C++ 표준상 미정의라
  //    MSB/LSB가 뒤바뀔 수 있다(agy 검토 지적, 2026-08-03) — 명시적으로 순서를 고정한다.
  uint8_t msb = WireIna.read();
  uint8_t lsb = WireIna.read();
  uint16_t raw = ((uint16_t)msb << 8) | lsb;
  volts = raw * 0.00125f;          // LSB 1.25mV — docs/sensor_wiring_guide.md §B-3
  return true;
}

// ============================================================================
// 하드웨어 계층 — 여기서만 거울대칭을 안다
// ============================================================================

void setMotor(int dirPin, int pwmPin, int ch, float pct) {
  if (pct > 0) {
    digitalWrite(dirPin, HIGH);
  } else {
    digitalWrite(dirPin, LOW);
    pct = -pct;
  }
  if (pct > 100.0f) pct = 100.0f;
  SET_PWM(pwmPin, ch, (uint32_t)(pct * PWM_MAX / 100));
}

// 정규화 duty(+=전진)를 실제 핀에 건다.
void applyWheel(bool left, float duty_norm) {
  // 🔴 [실측 2026-08-03] 좌우 **모두** DIR LOW 가 전진이다(위 핀 표 참조).
  //    모터 리드가 한쪽만 뒤집혀 배선돼 있어 **거울대칭이 이미 배선에서 흡수**됐다.
  //    그래서 종전의 `left ? d : -d`(우측만 뒤집기)는 이중 반전이 되어
  //    좌측이 거꾸로 돌았다 — 전진 명령에 차체가 제자리 선회하던 원인이다.
  //    setMotor 는 pct<0 에서 DIR LOW 를 걸므로 양쪽을 같이 뒤집는다.
  float d = -duty_norm;
  setMotor(left ? DIR1 : DIR2, left ? PWM1 : PWM2, left ? 0 : 1, d);
}

// 정규화 엔코더 카운트(+=전진). 우측은 물리적으로 감소하므로 부호를 뒤집는다 (§D-2).
inline int64_t countNorm(bool left) {
  return left ? encL.getCount() : -encR.getCount();
}

void stopAll() {
  wl.target = wr.target = 0.0f;
  wl.integ = wr.integ = 0.0f;
  wl.duty = wr.duty = 0.0f;
  applyWheel(true, 0); applyWheel(false, 0);
  mode = MODE_IDLE;
}

// ============================================================================
// 제어 계층
// ============================================================================

// 피드포워드: 목표속도 → 대략의 duty. 데드밴드를 넘겨 주는 것이 핵심 역할이다.
float feedforward(float target) {
  if (fabsf(target) < 1e-4f) return 0.0f;
  float d = target / tun.ff_slope;
  return d + (target > 0 ? tun.ff_dead : -tun.ff_dead);
}

// 🔴 [2026-08-03 · S15P11E101-647] eff_target 파라미터를 없애고 w.target 직접 사용으로
//    되돌렸다. 커밋 b12e34d 가 "하향평준화"라는 이름으로 넣은 크로스 커플링 항이
//    실은 **양성 피드백**이었다(과속 구간에서 반대쪽 목표를 낮추는 게 아니라 올렸다).
//    적분 리셋 판정이 eff_target 을 보고 있던 것도 같이 해소된다 — 크로스항이 만든
//    0 아닌 eff_target 때문에 목표 0 에서도 적분이 계속 쌓이고 있었다.
void controlWheel(Wheel &w, bool left, float dt) {
  int64_t c = countNorm(left);
  float raw = (float)(c - w.prev_count) * MM_PER_COUNT / 1000.0f / dt;
  w.prev_count = c;
  w.v += tun.v_alpha * (raw - w.v);        // EMA

  if (mode != MODE_VELOCITY) return;

  float err = w.target - w.v;
  float ff = feedforward(w.target);
  float p = tun.kp * err;

  // 적분 — 목표 0이면 크리프 방지를 위해 비운다
  if (fabsf(w.target) < 1e-4f) {
    w.integ = 0.0f;
  } else {
    float cand = w.integ + tun.ki * err * dt;
    // 조건부 적분(와인드업 방지): 포화 방향으로는 더 쌓지 않는다
    float unsat = ff + p + cand;
    bool pushing_out = (unsat > tun.duty_max && err > 0) ||
                       (unsat < -tun.duty_max && err < 0);
    if (!pushing_out) w.integ = constrain(cand, -tun.i_limit, tun.i_limit);
  }

  float duty = ff + p + w.integ;
  w.duty = constrain(duty, -tun.duty_max, tun.duty_max);
  applyWheel(left, w.duty);
}

// ============================================================================
// 명령 파싱
// ============================================================================

void openLoopPair(float pl, float pr) {   // 정규화 duty (+ = 전진)
  mode = MODE_OPENLOOP;
  wl.duty = pl; wr.duty = pr;
  applyWheel(true, pl); applyWheel(false, pr);
  lastCmdMs = millis();
}

void printTunables() {
  Serial.printf("# kp=%.2f ki=%.2f ff_slope=%.5f ff_dead=%.2f "
                "i_limit=%.1f duty_max=%.1f v_alpha=%.2f deadman=%lums\n",
                tun.kp, tun.ki, tun.ff_slope, tun.ff_dead,
                tun.i_limit, tun.duty_max, tun.v_alpha, (unsigned long)deadman_ms);
}

void handleCommand() {
  char c = Serial.read();
  switch (c) {
    case 'v': {                            // ⭐ 속도 폐루프: v <좌 m/s> <우 m/s>
      float a = Serial.parseFloat();
      float b = Serial.parseFloat();
      if (mode != MODE_VELOCITY) { wl.integ = wr.integ = 0.0f; }
      wl.target = a; wr.target = b;
      mode = MODE_VELOCITY;
      lastCmdMs = millis();
      break;
    }
    // ---- 이하 오픈루프 (drive_test.ino 호환 — S1 스크립트가 쓴다) ----
    case 'f': { int p = Serial.parseInt(); openLoopPair( p,  p); break; }
    case 'b': { int p = Serial.parseInt(); openLoopPair(-p, -p); break; }
    case 'l': { int p = Serial.parseInt(); openLoopPair( p,  0); break; }
    case 'm': { int p = Serial.parseInt(); openLoopPair( 0,  p); break; }
    case 'd': {                            // d <좌> <우> — 원시 duty, 부호는 정규화 기준
      int pl = Serial.parseInt();
      int pr = Serial.parseInt();
      openLoopPair(pl, pr);
      break;
    }
    case 's': stopAll(); break;
    case 'r': encL.clearCount(); encR.clearCount();
              wl.prev_count = wr.prev_count = 0; break;
    case 'c': {                            // c <angle> — 서보 틸트 각도 (0~180, 소수점 허용)
      // 🔴 종전에는 parseInt 라 1도 단위였다. 노즈설계 §5 의 링크 레버비
      //    (서보 18.2° → 암 12°, 즉 0.66)를 곱해도 카메라에서 **0.66° 스텝**이다.
      //    IPM 거리추정은 pitch 오차가 그대로 증폭돼(docs/단안깊이_조사_2026-08-02.md §3-2)
      //    1 m 에서 pitch 1° = 11.9% 다 → 0.66° 스텝만으로 **7.9% = 79 mm** 를 먹는다.
      //
      //    그런데 PWM 은 이미 서보 1도당 (8192-1638)/180 = **36.4 카운트**를 갖고 있다.
      //    분해능 제약은 하드웨어가 아니라 **파서였다.** parseFloat 로 바꾸면
      //    0.1° 지령 → 카메라 0.066° → 1 m 에서 0.8% 가 된다.
      //
      //    ⚠️ 하위호환: `c 90` 같은 정수 명령은 그대로 동작하고, 계산 결과도
      //    종전 map() 과 **비트 단위로 같다**(90 → 4915). 기존 호출부를 안 고쳐도 안 깨진다.
      //    🔴 단 위층 두 곳(server.py `_servo` · esp32_base_node `servo_tick`)이
      //    int() 로 먼저 자르고 있으므로, **여기만 고치면 아무 효과가 없다.** 셋을 같이 고친다.
      float deg = Serial.parseFloat();
      deg = constrain(deg, 0.0f, 180.0f);
      SET_PWM(SERVO_PIN, SERVO_CH,
              (uint32_t)lroundf(1638.0f + deg * (8192.0f - 1638.0f) / 180.0f));
      break;
    }
    case 'k': {                            // 상수 조정: k p 30  /  k ?  로 조회
      char w = Serial.read();
      if (w == '?') { printTunables(); break; }
      float val = Serial.parseFloat();
      switch (w) {
        case 'p': tun.kp = val; break;
        case 'i': tun.ki = val; break;
        case 'f': tun.ff_slope = val; break;
        case 'z': tun.ff_dead = val; break;
        case 'l': tun.i_limit = val; break;
        case 'x': tun.duty_max = val; break;
        case 'a': tun.v_alpha = val; break;
        case 'w': deadman_ms = (uint32_t)val; break;
        default: Serial.println("# k? p/i/f/z/l/x/a/w"); return;
      }
      printTunables();
      break;
    }
    case 't': tele_csv = !tele_csv; break;  // 텔레메트리 포맷 토글
    default: break;
  }
}

// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  Wire.begin(21, 22);
  Wire.setClock(400000);
  Wire.setTimeOut(50);   // 🔴 2026-08-03 실차 사고 이후 추가 — I2C가 멈추면(SDA/SCL 접촉불량,
                          // 클럭 스트레칭 등) endTransmission/requestFrom이 타임아웃 없이 영원히
                          // 블로킹돼 loop() 전체가 멈춘다 — 그러면 데드맨 체크도 같이 멈춰서
                          // PWM이 마지막 값에 얼어붙는다(실제로 발생, 배터리 분리로만 정지됨).
                          // 50ms면 실패로 간주하고 loop()가 계속 돌게 강제한다.
  if (mlx.begin(MLX90640_I2CADDR_DEFAULT, &Wire)) {
    mlx_ok = true;
    mlx.setMode(MLX90640_CHESS);
    mlx.setResolution(MLX90640_ADC_18BIT);
    mlx.setRefreshRate(MLX90640_4_HZ); // 4Hz
    Serial.println("# MLX90640 init success");
  } else {
    Serial.println("# MLX90640 NOT found");
  }

  WireIna.begin(14, 27, 400000);          // INA226 전용 버스 — MLX90640과 분리
  WireIna.setTimeOut(50);                 // 🔴 위 Wire.setTimeOut 과 같은 이유 — 절대 무한블로킹 금지
  WireIna.beginTransmission(INA226_ADDR);
  ina_present = (WireIna.endTransmission() == 0);
  Serial.println(ina_present ? "# INA226 init success" : "# INA226 NOT found");

  dht.begin();
  Serial.println("# DHT11 configured (GPIO15) — 성공 여부는 첫 읽기(최대 1s 후) 이후 확인됨");

  pinMode(DIR1, OUTPUT); pinMode(DIR2, OUTPUT);
  INIT_PWM(PWM1, 0, PWM_HZ, PWM_BITS);
  INIT_PWM(PWM2, 1, PWM_HZ, PWM_BITS);
  
  INIT_PWM(SERVO_PIN, SERVO_CH, 50, 16);
  SET_PWM(SERVO_PIN, SERVO_CH, map(90, 0, 180, 1638, 8192)); // 서보 초기위치 90도 중앙

  ESP32Encoder::useInternalWeakPullResistors = PU_UP;
  encL.attachFullQuad(L_A, L_B);
  encR.attachFullQuad(R_A, R_B);
  encL.setFilter(1023);                    // 12.7µs 미만 펄스 무시 (하드웨어 글리치 필터)
  encR.setFilter(1023);
  encL.clearCount(); encR.clearCount();

  stopAll();
  Serial.println("=== speed_pid v1 === v <L m/s> <R m/s> | f/b/l/m/d/s/r | c <deg> | k ? | t");
  Serial.println("# 부호: 양쪽 다 + = 전진 (거울대칭은 펌웨어가 흡수)");
  printTunables();
}

void loop() {
  while (Serial.available()) handleCommand();

  unsigned long now = millis();

  if (mlx_ok && mode == MODE_VELOCITY && (now - lastMlxMs >= 500)) {
    if (mlx.getFrame(mlxFrame) == 0) {
      Serial.print("IR,");
      Serial.print(now);
      Serial.print(",");
      for(int i=0; i<768; i++) {
        int16_t dc = (int16_t)(mlxFrame[i] * 10.0f);
        char buf[5];
        sprintf(buf, "%04X", (uint16_t)dc);
        Serial.print(buf);
      }
      Serial.println();
      lastMlxMs = millis();
    }
  }

  if (now - lastCtrlMs >= CTRL_MS) {
    float dt = (now - lastCtrlMs) / 1000.0f;
    lastCtrlMs = now;
    
    // 🔴 [2026-08-03 · S15P11E101-647] 크로스 커플링("하향평준화") 항을 삭제했다.
    //    err<0(과속) 구간에서 `eff_tgt -= (음수)` 가 되어 반대쪽 목표를 **올렸다** —
    //    이름과 반대로 상향평준화였고, 두 바퀴가 서로를 밀어올리는 양성 피드백이었다.
    //    좌 바퀴를 손으로 0.2 m/s 돌리면 우 바퀴에 FF 12.4% duty 가 즉시 걸렸다.
    //    직진성 보정은 펌웨어가 아니라 상위 ROS 스택(오도메트리 피드백)의 몫이다.
    controlWheel(wl, true,  dt);
    controlWheel(wr, false, dt);

    // 데드맨 — 명령이 끊기면 정지. 오픈루프는 벤치 작업용이라 5초로 관대하게.
    // 🔴 [2026-08-03 · S15P11E101-648] 속도모드에서도 stopAll() 을 부른다.
    //    종전에는 목표만 0 으로 놓고 mode 를 MODE_VELOCITY 로 유지했다 —
    //    그러면 PID 가 **영원히 무장 상태**로 남아 측정속도만으로 계속 출력을 냈고,
    //    상위 ROS 프로세스를 kill 해도 안 멈춰 배터리 분리 외엔 정지 수단이 없었다.
    //    MODE_IDLE 이면 controlWheel 이 위에서 조기 return 하므로 applyWheel 자체가
    //    호출되지 않는다 — 이것이 진짜 무장해제다.
    uint32_t limit = (mode == MODE_VELOCITY) ? deadman_ms : 5000;
    if (mode != MODE_IDLE && now - lastCmdMs > limit) {
      stopAll();
      Serial.println("# auto-stop (deadman stopAll)");
    }
  }

  if (now - lastTeleMs >= tele_ms) {
    lastTeleMs = now;
    if (tele_csv) {
      // ROS 파싱용: T,millis,모드,좌목표,좌실측,좌duty,우목표,우실측,우duty,좌카운트,우카운트
      Serial.printf("T,%lu,%d,%.3f,%.3f,%.1f,%.3f,%.3f,%.1f,%lld,%lld\n",
                    now, (int)mode, wl.target, wl.v, wl.duty,
                    wr.target, wr.v, wr.duty,
                    (long long)countNorm(true), (long long)countNorm(false));
    } else {
      Serial.printf("L tgt%6.3f cur%6.3f duty%6.1f | R tgt%6.3f cur%6.3f duty%6.1f\n",
                    wl.target, wl.v, wl.duty, wr.target, wr.v, wr.duty);
    }
  }

  // ---------- 환경/배터리 센서 (1Hz, 최저 우선순위) ----------
  // 위 명령 파싱 → 제어 틱 → 텔레메트리 출력이 이미 다 끝난 뒤에만 실행된다.
  // DHT11 읽기(수 ms 비트뱅킹)·INA226 읽기(<1ms I2C)가 이 틱과 같은 millis()에 겹쳐도
  // 다음 제어 틱은 실측 dt(now - lastCtrlMs)로 스스로 보정하므로 적분 오차가 누적되지 않는다.
  if (now - lastEnvMs >= ENV_MS) {
    lastEnvMs = now;

    float h = dht.readHumidity();
    float t = dht.readTemperature();
    dht_ok = !(isnan(h) || isnan(t));
    if (dht_ok) { dhtHumidity = h; dhtTempC = t; }   // 실패 시 이전 값 래치 (NaN을 내보내지 않음)

    if (ina_present) {
      float v;
      ina_ok = inaReadBusVoltage(v);
      if (ina_ok) inaVoltage = v;                    // 실패 시 이전 값 래치
    }

    // E,millis,dht_ok,tempC,humidity%,ina_ok,batt_V
    // 기존 T,/IR, 파서와 무관한 별도 라인 — esp32_base_node.py의 serial_loop()는
    // "T,"로 시작하지 않는 줄을 이미 무시하므로(마지막 continue) 이 줄을 몰라도 안 깨진다.
    Serial.printf("E,%lu,%d,%.1f,%.1f,%d,%.3f\n",
                  now, dht_ok ? 1 : 0, dhtTempC, dhtHumidity,
                  ina_ok ? 1 : 0, inaVoltage);
  }
}
