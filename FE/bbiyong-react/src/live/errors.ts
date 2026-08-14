// 잡힌 예외에서 사람이 읽을 정보를 꺼내는 곳 (S15P11E101-576).
//
// useUnknownInCatchVariables 를 켜면 catch (e) 의 e 가 unknown 이 된다.
// 실제로 throw 되는 것이 Error 라는 보장이 없으므로 옳은 동작이지만,
// 화면마다 `e instanceof Error ? e.message : String(e)` 를 반복할 이유는 없다.

/** 화면에 보여줄 오류 문구. Error 가 아닌 것이 던져져도 문자열을 돌려준다. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  // 서버가 문자열이 아닌 것을 던지는 경우까지 화면이 깨지지 않게 한다
  try { return String(e) } catch { return '알 수 없는 오류' }
}

/**
 * REST 호출이 실은 상태 코드. authedSend 가 error.status 를 실어 던진다.
 * 404/405 처럼 "그 API 가 없다" 를 "요청 실패" 와 구분할 때 쓴다.
 */
export function errStatus(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'status' in e) {
    const v = (e as { status?: unknown }).status
    if (typeof v === 'number') return v
  }
  return undefined
}
