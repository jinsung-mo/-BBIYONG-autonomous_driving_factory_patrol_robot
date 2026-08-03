package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;

public class SimulatedRobotOverheatEvent extends RobotOverheatEvent {
    private final String recipientUserId;
    public SimulatedRobotOverheatEvent(Object source, RobotPacket packet, String recipientUserId) {
        super(source, packet);
        this.recipientUserId = recipientUserId;
    }
    public String getRecipientUserId() { return recipientUserId; }
}
