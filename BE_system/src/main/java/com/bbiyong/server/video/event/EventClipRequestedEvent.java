package com.bbiyong.server.video.event;

import org.springframework.context.ApplicationEvent;

import java.time.Instant;

/**
 * 위험 이벤트가 DB 에 저장되어 {@code eventId} 가 확정된 직후 발행된다.
 * {@code EventClipService} 가 이 시각을 기준으로 HLS 세그먼트를 잘라 사건 클립을 만든다.
 *
 * <p>왜 저장 이후인가 — 클립은 {@code video_clips.event_id} 로 이벤트에 붙어야 관제 상세
 * 화면(FE {@code EventDetailModal} → {@code GET /api/events/{eventId}/video})에 뜬다.
 * 저장 전에는 그 값이 없다.
 *
 * <p>{@code occurredAt} 은 <b>로봇이 위험을 확정한 시각</b>이다(경보 payload 의 timestamp).
 * 서버 수신 시각이 아니다 — 영상에서 불이 보이는 순간을 찾으려면 로봇의 시각이어야 한다.
 * 로봇과 AWS 의 시계 차이는 실측 1초 이내다(2026-08-13 동시 측정).
 */
public class EventClipRequestedEvent extends ApplicationEvent {

    private final Long eventId;
    private final String robotId;
    private final String type;
    private final Instant occurredAt;

    public EventClipRequestedEvent(Object source, Long eventId, String robotId, String type, Instant occurredAt) {
        super(source);
        this.eventId = eventId;
        this.robotId = robotId;
        this.type = type;
        this.occurredAt = occurredAt;
    }

    public Long getEventId() {
        return eventId;
    }

    public String getRobotId() {
        return robotId;
    }

    /** FIRE | OVERHEAT | CAUTION … 이벤트 종류. 어떤 종류에 클립을 만들지는 설정으로 고른다. */
    public String getType() {
        return type;
    }

    public Instant getOccurredAt() {
        return occurredAt;
    }
}
