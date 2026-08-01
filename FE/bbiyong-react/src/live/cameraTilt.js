// @ts-check
// 전면 카메라 상하 각도 — S15P11E101-521.
//
// 로봇 명령 계약이 아직 없다. 저장소 어디에도 tilt/servo/gimbal 개념이 없고
// (cloud_bridge 가 아는 명령은 DRIVE·ESTOP, camera_node.py 는 영상·탐지 발행 전용),
// BE ControlCommand 에도 카메라 필드가 없다. vehicle.example.yaml 은 오히려
// "no steering servo" 라고만 적혀 있다.
//
// 그래서 명령 이름·단위·범위를 여기 한 곳에 잠정 정의한다. 로봇 파트가 확정되면
// 이 파일만 고치면 화면 코드는 그대로다.
//
// 절대각으로 보낸다(증분이 아니라). 증분은 유실·중복 시 실제 각도가 화면과 어긋나는데,
// 절대각은 같은 명령을 몇 번 보내도 같은 자세로 수렴한다.

// `|| {}` 는 방어용이라 그대로 둔다. 타입만 넓혀 준다(런타임 변화 없음).
const env = /** @type {Record<string, string | undefined>} */ (import.meta.env || {})
const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const TILT_COMMAND = 'SET_CAMERA_TILT'

// 가동 범위(도). 위가 +. 하드웨어가 정해지면 env 또는 이 상수를 고친다.
export const TILT_MIN = num(env.VITE_CAMERA_TILT_MIN, -30)
export const TILT_MAX = num(env.VITE_CAMERA_TILT_MAX, 30)
export const TILT_STEP = Math.max(1, num(env.VITE_CAMERA_TILT_STEP, 5))

export const clampTilt = (deg) => Math.min(TILT_MAX, Math.max(TILT_MIN, Math.round(deg)))

export const atMax = (deg) => deg >= TILT_MAX
export const atMin = (deg) => deg <= TILT_MIN

// 로봇이 보고하는 현재 각도. 필드 이름도 아직 계약에 없어 후보를 넓게 받는다 —
// 못 받으면 null 이고, 화면은 '요청값'임을 밝힌다(보고값으로 위장하지 않는다).
export function reportedTilt(telemetry) {
  const v = telemetry?.cameraTilt ?? telemetry?.camera_tilt ?? telemetry?.tilt
  return Number.isFinite(Number(v)) ? Number(v) : null
}

export const formatTilt = (deg) => `${deg > 0 ? '+' : ''}${deg}°`
