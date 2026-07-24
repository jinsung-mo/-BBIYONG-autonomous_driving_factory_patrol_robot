package com.bbiyong.server.wss;

import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Slf4j
@Component
public class RobotWebSocketHandler extends TextWebSocketHandler {

    private final RobotWebSocketSessionManager sessionManager;
    private final ObjectMapper objectMapper;
    private final ApplicationEventPublisher eventPublisher;

    public RobotWebSocketHandler(RobotWebSocketSessionManager sessionManager,
                                 ObjectMapper objectMapper,
                                 ApplicationEventPublisher eventPublisher) {
        this.sessionManager = sessionManager;
        this.objectMapper = objectMapper;
        this.eventPublisher = eventPublisher;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        log.info("New WSS connection established from: {} (Session ID: {})", session.getRemoteAddress(), session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        if (payload == null || payload.trim().isEmpty()) {
            return;
        }

        try {
            RobotPacket packet = objectMapper.readValue(payload, RobotPacket.class);
            if (packet == null) {
                return;
            }

            String robotId = packet.getRobotId();
            if (robotId != null && !robotId.trim().isEmpty()) {
                sessionManager.register(robotId, session);
            }

            if (packet.getType() == null) {
                log.warn("Received WSS packet with missing type: {}", payload);
                return;
            }

            switch (packet.getType()) {
                case "REGISTER":
                    // 로봇 접속 시 세션 등록용 인사 패킷 (등록은 위에서 이미 수행)
                    log.info("Robot [{}] registered via WSS session [{}]", robotId, session.getId());
                    break;
                case "TELEMETRY":
                case "STATE_UPDATE":
                    eventPublisher.publishEvent(new RobotTelemetryEvent(this, packet));
                    break;
                case "EVENT_FIRE":
                    log.info("Fire event received via WSS from [{}]: confidence={}, temp={}",
                            robotId, packet.getConfidence(), packet.getTemperature());
                    eventPublisher.publishEvent(new RobotFireEvent(this, packet));
                    break;
                case "EVENT_OVERHEAT":
                    log.info("Overheat event received via WSS from [{}] for equipment [{}]: temp={}",
                            robotId, packet.getEquipmentId(), packet.getTemperature());
                    eventPublisher.publishEvent(new RobotOverheatEvent(this, packet));
                    break;
                default:
                    log.warn("Unknown WSS packet type [{}] in message: {}", packet.getType(), payload);
            }
        } catch (Exception e) {
            log.error("Failed to parse WSS JSON packet: {}, error: {}", payload, e.getMessage());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        log.info("WSS connection closed for session [{}] with status: {}", session.getId(), status);
        sessionManager.unregisterBySessionId(session.getId());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        log.error("Transport error in WSS session [{}]: {}", session.getId(), exception.getMessage());
        sessionManager.unregisterBySessionId(session.getId());
        if (session.isOpen()) {
            session.close(CloseStatus.SERVER_ERROR);
        }
    }
}
