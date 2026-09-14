package com.bbiyong.server.wss.event;

import org.springframework.context.ApplicationEvent;

/**
 * 로봇 실시간 내비게이션(2D 점유격자 맵) 수신 이벤트.
 *
 * <p>WSS 핸들러가 MAP 패킷 수신 시 발행하고, 리스너가 {@code /topic/nav/{robotId}} 로 중계한다.
 * 맵 cells(RLE)는 크고 서버가 해석할 필요가 없으므로, RobotPacket 으로 역/재직렬화하지 않고
 * 수신 원문(raw JSON)을 그대로 전달한다.
 */
public class RobotNavEvent extends ApplicationEvent {
    private final String robotId;
    private final String rawPayload;

    public RobotNavEvent(Object source, String robotId, String rawPayload) {
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
