package com.bbiyong.server.wss.event;

import com.bbiyong.server.wss.dto.RobotPacket;
import org.springframework.context.ApplicationEvent;

/**
 * 로봇이 올린 <b>조용한 시스템 로그</b>(WSS {@code type=EVENT_SYSTEM}).
 *
 * <p>화재({@link RobotFireEvent})·과열({@link RobotOverheatEvent})과 일부러 별도의
 * 이벤트 타입으로 둔다. 같은 타입으로 흘리면 {@code EventLogService.persist()} 를 타서
 * {@code /topic/alerts} 방송과 알림 발송이 자동으로 붙고, 관제에서 토스트와 경보음이
 * 울린다. 사용자 지침(2026-08-10)은 그 반대다 — "소리나 알림이 갈 필요는 없다.
 * 정말 로그만 보여달라."
 *
 * <p>그래서 이 이벤트의 처리 경로는 로봇 연결/해제 로그와 같다:
 * DB 에만 남고({@code level=INFO}), 소켓 방송·알림을 타지 않는다.
 */
public class RobotSystemLogEvent extends ApplicationEvent {
    private final RobotPacket packet;

    public RobotSystemLogEvent(Object source, RobotPacket packet) {
        super(source);
        this.packet = packet;
    }

    public RobotPacket getPacket() {
        return packet;
    }
}
