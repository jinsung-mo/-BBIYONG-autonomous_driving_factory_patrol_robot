package com.bbiyong.server.wss.event;

import org.springframework.context.ApplicationEvent;

/**
 * 로봇의 AprilTag 점검 지점(wall-ping) 메시지 수신 이벤트. (S15P11E101-778)
 *
 * <p>후보(inspection_candidate(s)) · 확정 목록(inspection_point(s)) · 점검 이벤트(inspection_point_event)를
 * 서버가 해석하지 않고 수신 원문(raw JSON)을 그대로 {@code /topic/inspection} 으로 관제에 relay 한다.
 * 좌표는 map 프레임 미터이며 순찰 지점과 동일 좌표계다.
 */
public class RobotInspectionPointEvent extends ApplicationEvent {
    private final String robotId;
    private final String rawPayload;

    public RobotInspectionPointEvent(Object source, String robotId, String rawPayload) {
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
