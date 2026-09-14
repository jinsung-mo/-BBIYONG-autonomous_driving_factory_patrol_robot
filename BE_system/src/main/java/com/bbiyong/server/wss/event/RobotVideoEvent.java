package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;
import org.springframework.context.ApplicationEvent;

/**
 * 로봇 듀얼 카메라(FRONT/THERMAL) 영상 프레임 수신 이벤트.
 * WSS 핸들러가 VIDEO_FRAME 패킷 수신 시 발행하고, 리스너가 /topic/video/{robotId} 로 중계한다.
 */
public class RobotVideoEvent extends ApplicationEvent {
    private final RobotPacket packet;

    public RobotVideoEvent(Object source, RobotPacket packet) {
        super(source);
        this.packet = packet;
    }

    public RobotPacket getPacket() {
        return packet;
    }
}
