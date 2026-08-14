package com.bbiyong.server.wss.event;

import org.springframework.context.ApplicationEvent;

/** A validated H.264 packet to be relayed without JSON/base64 conversion. */
public class RobotBinaryVideoEvent extends ApplicationEvent {
    private final String robotId;
    private final byte[] payload;

    public RobotBinaryVideoEvent(Object source, String robotId, byte[] payload) {
        super(source);
        this.robotId = robotId;
        this.payload = payload;
    }

    public String getRobotId() {
        return robotId;
    }

    public byte[] getPayload() {
        return payload;
    }
}
