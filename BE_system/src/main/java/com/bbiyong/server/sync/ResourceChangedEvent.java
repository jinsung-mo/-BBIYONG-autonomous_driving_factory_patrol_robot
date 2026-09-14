package com.bbiyong.server.sync;

/**
 * 공유 자원(순찰 경로·스케줄·저장 맵 등)이 바뀌었음을 알리는 애플리케이션 이벤트.
 *
 * <p>REST 로 자원을 바꾸면 바꾼 사람 화면만 갱신되고 다른 접속자는 새로고침 전까지
 * 옛 값을 본다 — 변경 시점에 이 이벤트를 발행하면 {@link ResourceSyncBroadcaster} 가
 * {@code /topic/sync} 로 알리고, 각 클라이언트가 해당 자원만 다시 불러온다.
 *
 * <p>payload 에 자원 내용은 싣지 않는다. 내용까지 실으면 자원마다 직렬화 계약이 하나씩
 * 늘어나는데, 클라이언트는 어차피 기존 GET 계약으로 다시 읽는 편이 정확하다.
 *
 * @param resource 자원 식별자 — REST 경로 이름을 그대로 쓴다(예: {@code patrol-route},
 *                 {@code patrol-schedules}, {@code maps})
 * @param robotId  로봇 단위 자원이면 그 로봇 ID, 전역 자원이면 null
 */
public record ResourceChangedEvent(String resource, String robotId) {
}
