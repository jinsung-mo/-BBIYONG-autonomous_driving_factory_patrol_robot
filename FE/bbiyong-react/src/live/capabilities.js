// @ts-check
// 로봇 서브시스템 생존 상태 — TELEMETRY.capabilities (S15P11E101-458)
//
// 로봇 브리지(cloud_bridge.py)가 /tmp 파일 mtime 으로 판정해 보고한다.
//   online  갱신 중(≤3s) · stale  잠깐 끊김(≤10s) · offline  멈춤·미기동
//
// 중요 — 브리지는 값이 없으면 필드를 null 로 채우지 않고 **아예 생략**한다.
// 그래서 '보고하지 않음(unknown)'과 'offline'은 다른 뜻이다.
//   capabilities 자체가 없음  → 이 로봇은 생존 상태를 보고하지 않는다(unknown, 배지 숨김)
//   capabilities 는 있는데 키가 없음 → 그 서브시스템은 존재하지 않는다(offline 취급)
// 열화상이 후자다. 로봇이 THERMAL 을 생산하지 않으므로 caps 에 키가 없고,
// 그때 화면이 목업처럼 보이지 않도록 offline 으로 처리한다.

export const CAP_ONLINE = 'online'
export const CAP_STALE = 'stale'
export const CAP_OFFLINE = 'offline'
export const CAP_UNKNOWN = 'unknown'

// 패널 → 로봇 서브시스템 키
export const CAP_KEYS = {
  camera: 'camera',       // 전면 카메라
  thermal: 'thermal',     // 열화상 — 로봇이 보고하지 않는다(키 없음 → offline)
  map: 'lidar_map',       // 2D SLAM 맵
  drive: 'drive',         // 주행(수동 조작)
}

const LABEL = {
  [CAP_ONLINE]: '정상',
  [CAP_STALE]: '지연',
  [CAP_OFFLINE]: '중단',
}

// 텔레메트리에서 해당 서브시스템 상태를 뽑는다.
// enabled(=live 모드)가 아니면 시뮬이므로 판정 대상이 아니다.
export function capOf(telemetry, key) {
  const caps = telemetry?.capabilities
  if (!caps || typeof caps !== 'object') return CAP_UNKNOWN
  const v = caps[key]
  if (v === CAP_ONLINE || v === CAP_STALE || v === CAP_OFFLINE) return v
  // caps 는 왔는데 이 키가 없다 → 로봇에 그 서브시스템이 없다
  return CAP_OFFLINE
}

export const capLabel = (state) => LABEL[state] || ''

// 데이터가 오지 않는 패널인지 — 흐리게 + '데이터 없음' 안내를 띄울 기준
export const isDown = (state) => state === CAP_OFFLINE
