package com.bbiyong.server.tcp.event;

import com.bbiyong.server.tcp.dto.RobotPacket;
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
