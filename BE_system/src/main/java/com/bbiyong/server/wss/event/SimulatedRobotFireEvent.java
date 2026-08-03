package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;

public class SimulatedRobotFireEvent extends RobotFireEvent {
    private final String recipientUserId;
    public SimulatedRobotFireEvent(Object source, RobotPacket packet, String recipientUserId) {
        super(source, packet);
        this.recipientUserId = recipientUserId;
    }
    public String getRecipientUserId() { return recipientUserId; }
}
