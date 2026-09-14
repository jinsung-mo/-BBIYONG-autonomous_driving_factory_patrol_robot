package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;
import org.springframework.context.ApplicationEvent;

/**
 * 로봇의 분전반 정상 점검 리포트(INSPECTION) 이벤트.
 * 임계치 미초과(정상) 시 발행되며, 설비 최근 점검 상태 갱신에 사용된다. (경보 아님)
 */
public class RobotInspectionEvent extends ApplicationEvent {
    private final RobotPacket packet;

    public RobotInspectionEvent(Object source, RobotPacket packet) {
        super(source);
        this.packet = packet;
    }

    public RobotPacket getPacket() {
        return packet;
    }
}
