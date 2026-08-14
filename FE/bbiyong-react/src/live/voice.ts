// 음성 안내(더빙) 재생 (S15P11E101-891).
//
// 관제 화면의 주요 사건에 사람 목소리 안내를 입힌다. 파일은 public/audio 에 있고
// Vite 가 루트(/audio/…)로 서빙한다 — 번들에 넣지 않는다(용량·캐시 이점).
//
// 🔴 자동재생 정책: 브라우저는 사용자 제스처 없이 시작한 오디오를 막을 수 있다.
//   - 매핑/순찰 안내는 버튼 클릭(제스처) 직후라 항상 허용된다.
//   - 화재/과열 안내는 서버 경보로 트리거되지만, 로그인 이후 세션에는 이미 클릭이
//     있었으므로 대개 허용된다. 막히면 play() 가 reject 되는데, 조용히 무시한다
//     (팝업·점멸 같은 시각 경보는 그대로 뜬다).

const SRC = {
  mappingStart: '/audio/mapping-start.mp3',  // 01 맵핑을 시작합니다
  patrolStart: '/audio/patrol-start.mp3',    // 02 순찰을 시작합니다
  overheat: '/audio/overheat.mp3',           // 03 과열을 탐지했습니다
  fireFound: '/audio/fire-found.mp3',        // 04 화재를 발견하였습니다
  fireAlarm: '/audio/fire-alarm.mp3',        // 05 화재감지 알람
} as const

export type VoiceName = keyof typeof SRC

// 안내·경보 음량(0~1). 기본 0.5 = 최대 대비 절반. env(VITE_VOICE_VOLUME)로 조절.
const VOLUME = Math.min(1, Math.max(0, Number(import.meta.env.VITE_VOICE_VOLUME ?? 0.5)))

// 클립마다 Audio 하나를 재사용한다 — 새로 만들면 디코드가 반복돼 시작이 늦다.
const cache = new Map<VoiceName, HTMLAudioElement>()
function el(name: VoiceName): HTMLAudioElement {
  let a = cache.get(name)
  if (!a) {
    a = new Audio(SRC[name])
    a.preload = 'auto'
    cache.set(name, a)
  }
  // 재사용 요소라도 매번 맞춰 둔다 — 외부에서 바뀌었더라도 일관 음량 유지.
  a.volume = VOLUME
  return a
}

/** 클립을 한 번 처음부터 재생한다. 이미 재생 중이면 되감아 다시 시작한다. */
export function playVoice(name: VoiceName): void {
  try {
    const a = el(name)
    a.loop = false
    a.currentTime = 0
    void a.play().catch(() => { /* 자동재생 차단 — 시각 경보로 대체된다 */ })
  } catch { /* 오디오 미지원 환경 */ }
}

/** 클립을 멈추고 처음으로 되감는다. */
export function stopVoice(name: VoiceName): void {
  try {
    const a = cache.get(name)
    if (!a) return
    a.loop = false
    a.pause()
    a.currentTime = 0
  } catch { /* 무시 */ }
}

/**
 * 화재 안내 시퀀스 (S15P11E101-891).
 * "화재를 발견하였습니다"(04)를 1회 재생하고, 끝나면 "화재감지 알람"(05)을 반복한다.
 * 관제자가 [확인]을 누르기 전까지 05 가 계속 울린다.
 * @returns 시퀀스를 즉시 멈추는 함수. 04 재생 중이든 05 반복 중이든 안전하게 끊는다.
 */
export function playFireSequence(): () => void {
  const found = el('fireFound')
  const alarm = el('fireAlarm')
  let stopped = false

  const startAlarmLoop = () => {
    if (stopped) return
    try { alarm.loop = true; alarm.currentTime = 0; void alarm.play().catch(() => {}) } catch { /* 무시 */ }
  }
  // 04 가 끝나면 05 반복을 시작한다. 04 가 차단돼 재생되지 않으면 ended 가 오지 않으므로,
  // 안전망으로 재생을 시도하되 실패 시 곧바로 05 로 넘어간다.
  const onFoundEnd = () => startAlarmLoop()
  found.addEventListener('ended', onFoundEnd, { once: true })
  try {
    found.loop = false
    found.currentTime = 0
    void found.play().then(() => { /* 재생 시작됨 — ended 를 기다린다 */ }).catch(() => startAlarmLoop())
  } catch { startAlarmLoop() }

  return () => {
    stopped = true
    found.removeEventListener('ended', onFoundEnd)
    try { found.pause(); found.currentTime = 0 } catch { /* 무시 */ }
    try { alarm.loop = false; alarm.pause(); alarm.currentTime = 0 } catch { /* 무시 */ }
  }
}
