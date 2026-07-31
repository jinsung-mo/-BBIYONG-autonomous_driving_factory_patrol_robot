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
#include <ESP32Encoder.h>

// ---------- 핀 (docs/실측_데이터.md §A) ----------
constexpr int L_A = 32, L_B = 33, R_A = 25, R_B = 26;
// 🔴 2026-07-29 재조립 배선 교차 보정.
//    오픈루프 실측: ch1(구 GPIO18/19) 에 duty 를 주면 물리적 **우측** 바퀴가 돌았다
//    (좌 duty30 → 우 카운트 -8442 / 좌 카운트 0. duty60 에서 정확히 2배).
//    엔코더는 정상이다 — 손으로 좌측 바퀴를 돌리면 L 카운트에 잡힌다.
//    즉 교차는 **모터 출력 쪽**이다. 논리 채널을 물리 바퀴에 다시 맞춘다.
//    ⚠️ 배선(MDD10A 출력 또는 제어 5핀)을 바로잡으면 이 교차를 원복할 것.
constexpr int PWM1 = 23, DIR1 = 13;      // 좌  ← 구 PWM2/DIR2
constexpr int PWM2 = 18, DIR2 = 19;      // 우  ← 구 PWM1/DIR1

// ---------- 확정 상수 ----------
constexpr float MM_PER_COUNT = 0.16348f; // [실측] §J-2
constexpr int   PWM_HZ = 20000, PWM_BITS = 10;   // MDD10A 상한
constexpr int   PWM_MAX = (1 << PWM_BITS) - 1;
constexpr uint32_t CTRL_HZ = 50;                 // 0.3m/s에서 20ms당 37카운트
constexpr uint32_t CTRL_MS = 1000 / CTRL_HZ;

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

// ============================================================================
// 하드웨어 계층 — 여기서만 거울대칭을 안다
// ============================================================================

// 정규화 duty(+=전진)를 실제 핀에 건다.
// 우측은 물리적으로 반대로 돌아야 전진이므로 여기서 뒤집는다 (§D-1).
void applyWheel(bool left, float duty_norm) {
  float d = left ? duty_norm : -duty_norm;         // ← 거울대칭 흡수 지점
  int pct = (int)(fabsf(d) + 0.5f);
  if (pct > 100) pct = 100;
  int pwmPin = left ? PWM1 : PWM2;
  int dirPin = left ? DIR1 : DIR2;
  digitalWrite(dirPin, d >= 0);
  ledcWrite(pwmPin, (uint32_t)pct * PWM_MAX / 100);
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

  pinMode(DIR1, OUTPUT); pinMode(DIR2, OUTPUT);
  ledcAttach(PWM1, PWM_HZ, PWM_BITS);
  ledcAttach(PWM2, PWM_HZ, PWM_BITS);

  ESP32Encoder::useInternalWeakPullResistors = puType::up;
  encL.attachFullQuad(L_A, L_B);
  encR.attachFullQuad(R_A, R_B);
  encL.setFilter(1023);                    // 12.7µs 미만 펄스 무시 (하드웨어 글리치 필터)
  encR.setFilter(1023);
  encL.clearCount(); encR.clearCount();

  stopAll();
  Serial.println("=== speed_pid v1 === v <L m/s> <R m/s> | f/b/l/m/d/s/r | k ? | t");
  Serial.println("# 부호: 양쪽 다 + = 전진 (거울대칭은 펌웨어가 흡수)");
  printTunables();
}

void loop() {
  while (Serial.available()) handleCommand();

  unsigned long now = millis();

  if (now - lastCtrlMs >= CTRL_MS) {
    float dt = (now - lastCtrlMs) / 1000.0f;
    lastCtrlMs = now;
    controlWheel(wl, true,  dt);
    controlWheel(wr, false, dt);

    // 데드맨 — 명령이 끊기면 정지. 오픈루프는 벤치 작업용이라 5초로 관대하게.
    uint32_t limit = (mode == MODE_VELOCITY) ? deadman_ms : 5000;
    if (mode != MODE_IDLE && now - lastCmdMs > limit) {
      stopAll();
      Serial.println("# auto-stop (deadman)");
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
}
