package com.bbiyong.server.tcp.event;

import com.bbiyong.server.tcp.dto.RobotPacket;
import org.springframework.context.ApplicationEvent;

public class RobotFireEvent extends ApplicationEvent {
    private final RobotPacket packet;

    public RobotFireEvent(Object source, RobotPacket packet) {
        super(source);
        this.packet = packet;
    }

    public RobotPacket getPacket() {
        return packet;
    }
}
