// 로봇 표시명 (S15P11E101-766)
//
// 화면에 보이는 이름과 계약에 쓰는 id 를 갈라 둔다.
//
// robot_id 'orinka_01' 은 WSS HELLO 인증, STOMP 토픽 경로(/topic/video/orinka_01,
// /topic/nav/orinka_01), REST 파라미터에 그대로 쓰인다 — 로봇·서버가 그 문자열로
// 서로를 찾는다. 여기서 바꾸면 통신이 끊긴다.
//
// 그래서 이 파일은 '그리기 직전' 에만 쓴다. 구독·발행·요청에는 절대 쓰지 않는다.

/** 등록된 표시명. 없는 id 는 원문을 그대로 쓴다 — 이름을 지어내면 어느 로봇인지 잃는다. */
const DISPLAY_NAMES: Record<string, string> = {
  orinka_01: 'BBIYONGBOT_01',
}

/**
 * 사용자에게 보여 줄 이름.
 * @param robotId 로봇 계약 id
 */
export function displayName(robotId: string | null | undefined): string {
  if (!robotId) return ''
  return DISPLAY_NAMES[robotId] ?? robotId
}

// 문자열 안에 박힌 id 를 찾기 위한 정규식. 긴 id 부터 바꿔야 짧은 id 가 앞부분만
// 갉아먹는 일이 없다(예: robot_1 이 robot_10 을 망가뜨리는 경우).
const ESCAPED = Object.keys(DISPLAY_NAMES)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const ID_RE = ESCAPED.length ? new RegExp(ESCAPED.join('|'), 'g') : null

/**
 * 서버가 만들어 준 문장 안의 id 를 표시명으로 바꾼다.
 *
 * EventLog.message 처럼 BE 가 조립한 문자열에는 robotId 가 그대로 박혀 온다.
 * 그 문장을 다시 만들 수는 없으니(문구는 BE 의 것이다) 그리기 직전에 갈아 끼운다.
 *
 * @param text 서버 문구
 */
export function withDisplayNames(text: string | null | undefined): string {
  if (!text) return text ?? ''
  if (!ID_RE) return text
  return text.replace(ID_RE, (m) => DISPLAY_NAMES[m] ?? m)
}
