package com.bbiyong.server.wss.event;

import org.springframework.context.ApplicationEvent;

/**
 * 로봇의 온디맨드 매핑 완료(EVENT_MAPPING_COMPLETE) 수신 이벤트.
 *
 * <p>WSS 핸들러가 수신 시 발행하고, 리스너가 {@code /topic/mapping} 으로 관제에 relay 한다.
 * 완료 페이로드(맵 이름 등)는 수신 원문(raw JSON)을 그대로 전달한다.
 */
public class RobotMappingCompleteEvent extends ApplicationEvent {
    private final String robotId;
    private final String rawPayload;

    public RobotMappingCompleteEvent(Object source, String robotId, String rawPayload) {
        super(source);
        this.robotId = robotId;
        this.rawPayload = rawPayload;
    }

    public String getRobotId() {
        return robotId;
    }

    public String getRawPayload() {
        return rawPayload;
    }
}
