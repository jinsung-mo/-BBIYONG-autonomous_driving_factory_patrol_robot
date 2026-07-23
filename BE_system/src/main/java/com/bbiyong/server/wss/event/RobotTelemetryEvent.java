package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;
import org.springframework.context.ApplicationEvent;

public class RobotTelemetryEvent extends ApplicationEvent {
    private final RobotPacket packet;

    public RobotTelemetryEvent(Object source, RobotPacket packet) {
        super(source);
        this.packet = packet;
    }

    public RobotPacket getPacket() {
        return packet;
    }
}
