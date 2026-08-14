package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;
import org.springframework.context.ApplicationEvent;

/** RGB·열화상 복합 확정 전 후보 위험을 관제 이력으로 전달한다. */
public class RobotCautionEvent extends ApplicationEvent {
    private final RobotPacket packet;

    public RobotCautionEvent(Object source, RobotPacket packet) {
        super(source);
        this.packet = packet;
    }

    public RobotPacket getPacket() {
        return packet;
    }
}
