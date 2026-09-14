package com.bbiyong.server.wss.event;

import org.springframework.context.ApplicationEvent;

/**
 * 로봇 WSS 세션이 새로 등록(연결 성립·재연결)되었을 때 발행된다. (S15P11E101-683)
 *
 * <p>{@link RobotDisconnectedEvent} 와 대칭 — 리스너가 /topic/robots 로
 * STATE_UPDATE(ONLINE) 를 브로드캐스트해 관제 시스템 탭이 연결 로그를 남길 수 있게 한다.
 */
public class RobotConnectedEvent extends ApplicationEvent {
    private final String robotId;

    public RobotConnectedEvent(Object source, String robotId) {
        super(source);
        this.robotId = robotId;
    }

    public String getRobotId() {
        return robotId;
    }
}
