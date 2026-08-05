package com.bbiyong.server.wss;

import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.dto.H264BinaryFrame;
import com.bbiyong.server.wss.event.RobotBinaryVideoEvent;
import com.bbiyong.server.wss.event.RobotConnectedEvent;
import com.bbiyong.server.wss.event.RobotDisconnectedEvent;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotInspectionEvent;
import com.bbiyong.server.wss.event.RobotMappingCompleteEvent;
import com.bbiyong.server.wss.event.RobotNavEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import com.bbiyong.server.wss.event.RobotVideoEvent;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.BinaryMessage;
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
                // 세션-로봇 소유권 검사: 한 세션은 최초 등록한 robot_id 에 고정된다.
                // 같은 세션이 다른 robot_id 를 실어 보내면 타 로봇 사칭·세션 탈취이므로
                // 패킷을 폐기한다(바이너리 경로의 검사와 동일 정책). (S15P11E101-715)
                String boundRobotId = sessionManager.getRobotIdBySessionId(session.getId());
                if (boundRobotId != null && !boundRobotId.equals(robotId.trim())) {
                    log.warn("Dropping WSS packet with robot mismatch: session=[{}] bound=[{}], packet=[{}]",
                            session.getId(), boundRobotId, robotId);
                    return;
                }
                // 새 등록(연결·재연결)일 때만 ONLINE 이벤트 발행 — 관제 시스템 탭 연결 로그용. (S15P11E101-683)
                if (sessionManager.register(robotId, session)) {
                    eventPublisher.publishEvent(new RobotConnectedEvent(this, robotId));
                }
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
                case "VIDEO_FRAME":
                    eventPublisher.publishEvent(new RobotVideoEvent(this, packet));
                    break;
                case "EVENT_FIRE":
                    log.info("Fire event received via WSS from [{}]: confidence={}, temp={}",
                            robotId, packet.getConfidence(), packet.getTemperature());
                    eventPublisher.publishEvent(new RobotFireEvent(this, packet));
                    break;
                case "EVENT_OVERHEAT":
                    log.info("Overheat event received via WSS from [{}] for equipment [{}]: temp={}, threshold={}",
                            robotId, packet.getEquipmentId(), packet.getTemperature(), packet.getThreshold());
                    eventPublisher.publishEvent(new RobotOverheatEvent(this, packet));
                    break;
                case "INSPECTION":
                    // 분전반 정상 점검 리포트 (경보 아님) - 설비 최근점검 상태 갱신용
                    eventPublisher.publishEvent(new RobotInspectionEvent(this, packet));
                    break;
                case "EVENT_MAPPING_COMPLETE":
                    // 온디맨드 매핑 완료 - 수신 원문을 /topic/mapping 으로 관제에 relay
                    log.info("Mapping complete event received via WSS from [{}]", robotId);
                    if (robotId != null && !robotId.trim().isEmpty()) {
                        eventPublisher.publishEvent(new RobotMappingCompleteEvent(this, robotId, payload));
                    } else {
                        log.warn("Dropping EVENT_MAPPING_COMPLETE with missing robot_id");
                    }
                    break;
                case "MAP":
                case "NAV_LIVE":
                    // 실시간 내비게이션 데이터: MAP(2D 점유격자 RLE) / NAV_LIVE(pose·scan).
                    // 서버가 해석할 필요 없이 수신 원문을 그대로 /topic/nav/{robotId} 로 중계한다.
                    if (robotId != null && !robotId.trim().isEmpty()) {
                        eventPublisher.publishEvent(new RobotNavEvent(this, robotId, payload));
                    } else {
                        log.warn("Dropping {} packet with missing robot_id", packet.getType());
                    }
                    break;
                default:
                    log.warn("Unknown WSS packet type [{}] in message: {}", packet.getType(), payload);
            }
        } catch (Exception e) {
            log.error("Failed to parse WSS JSON packet: {}, error: {}", payload, e.getMessage());
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        try {
            String registeredRobotId = sessionManager.getRobotIdBySessionId(session.getId());
            if (registeredRobotId == null) {
                log.warn("Dropping binary video from unregistered WSS session [{}]", session.getId());
                return;
            }

            byte[] payload = new byte[message.getPayloadLength()];
            message.getPayload().get(payload);
            H264BinaryFrame frame = H264BinaryFrame.parse(payload);
            if (!registeredRobotId.equals(frame.robotId())) {
                log.warn("Dropping binary video with robot mismatch: session=[{}], packet=[{}]",
                        registeredRobotId, frame.robotId());
                return;
            }
            eventPublisher.publishEvent(new RobotBinaryVideoEvent(this, registeredRobotId, payload));
        } catch (IllegalArgumentException e) {
            log.warn("Dropping malformed H.264 binary packet from session [{}]: {}",
                    session.getId(), e.getMessage());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        log.info("WSS connection closed for session [{}] with status: {}", session.getId(), status);
        String robotId = sessionManager.unregisterBySessionId(session.getId());
        publishDisconnect(robotId);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        log.error("Transport error in WSS session [{}]: {}", session.getId(), exception.getMessage());
        String robotId = sessionManager.unregisterBySessionId(session.getId());
        if (session.isOpen()) {
            session.close(CloseStatus.SERVER_ERROR);
        }
        publishDisconnect(robotId);
    }

    private void publishDisconnect(String robotId) {
        if (robotId != null && !robotId.isBlank()) {
            eventPublisher.publishEvent(new RobotDisconnectedEvent(this, robotId));
        }
    }
}
