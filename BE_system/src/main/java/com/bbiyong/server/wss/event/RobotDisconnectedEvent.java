package com.bbiyong.server.wss.event;

import org.springframework.context.ApplicationEvent;

/**
 * 로봇 WSS 세션 종료 또는 telemetry 타임아웃으로 로봇이 오프라인이 되었을 때 발행된다.
 * 캐시 상태를 offline 으로 낮추고 /topic/robots 로 상태변경을 브로드캐스트하는 데 쓰인다.
 */
public class RobotDisconnectedEvent extends ApplicationEvent {
    private final String robotId;

    public RobotDisconnectedEvent(Object source, String robotId) {
        super(source);
        this.robotId = robotId;
    }

    public String getRobotId() {
        return robotId;
    }
}
