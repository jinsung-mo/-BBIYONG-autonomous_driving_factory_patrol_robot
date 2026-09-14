// 순찰 로봇의 "남은 기동 시간" 계산 (S15P11E101-814).
//
// ── 소모율 [실측 2026-08-08] ────────────────────────────────────────────────
// 🔴 지어낸 값이 아니다. 실제 로봇에서 10분간 20초 간격 26샘플을 받아 최소제곱으로 구했다.
//
//   출처   Orin `/tmp/orincar_env.json` — esp32_base_node 가 ESP32 시리얼
//          `E,<millis>,<dht_ok>,<tempC>,<humidity%>,<ina_ok>,<batt_V>` 를 1Hz 로 받아 쓰는 파일
//   구간   21.005 V / 32.3 %  →  20.904 V / 30.7 %  (8.7분)
//   기울기 −12.425 %/h  ( = −0.207 %/min ) · −0.770 V/h
//   신뢰도 잔차 RMS 0.224 %p → 10분 예상 변화가 잡음의 **9.2배**. 추세가 분명하다.
//
// 🔴 측정 시점 로봇은 **정지 상태**였다(mode=disabled, estop=true, 바퀴 duty 0).
//    그래도 이 값을 쓰는 근거: **주행 여부와 무관하게 소모전력이 비슷하다**
//    [사용자 확인 2026-08-08]. 대부분의 전력을 Orin·센서·통신이 쓰고 구동계 비중이 작다는 뜻이다.
//    ⚠ 이 전제가 깨지면(예: 모터 출력 상한을 올리면) 이 상수를 다시 재야 한다.
const PERCENT_PER_MINUTE: number | null = 0.207

/** 현재 배터리 %(0~100)로 남은 기동 시간(분)을 계산한다. 계수가 없으면 null. */
export function estimateRuntimeMinutes(batteryPercent: number | null): number | null {
  if (batteryPercent == null || !Number.isFinite(batteryPercent)) return null
  if (PERCENT_PER_MINUTE == null || PERCENT_PER_MINUTE <= 0) return null
  return Math.max(0, Math.round(batteryPercent / PERCENT_PER_MINUTE))
}
