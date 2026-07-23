package com.bbiyong.server.stomp;

import com.bbiyong.server.tcp.event.RobotFireEvent;
import com.bbiyong.server.tcp.event.RobotOverheatEvent;
import com.bbiyong.server.tcp.event.RobotTelemetryEvent;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class RobotEventListener {

    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;

    public RobotEventListener(SimpMessagingTemplate messagingTemplate, ObjectMapper objectMapper) {
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
    }

    @EventListener
    public void handleTelemetryEvent(RobotTelemetryEvent event) {
        try {
            String jsonStr = objectMapper.writeValueAsString(event.getPacket());
            log.info("Broadcasting Telemetry via STOMP to /topic/telemetry: {}", jsonStr);
            messagingTemplate.convertAndSend("/topic/telemetry", jsonStr);
        } catch (Exception e) {
            log.error("Failed to serialize telemetry event", e);
        }
    }

    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        try {
            String jsonStr = objectMapper.writeValueAsString(event.getPacket());
            log.info("Broadcasting FIRE ALERT via STOMP to /topic/events/fire: {}", jsonStr);
            messagingTemplate.convertAndSend("/topic/events/fire", jsonStr);
        } catch (Exception e) {
            log.error("Failed to serialize fire event", e);
        }
    }

    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        try {
            String jsonStr = objectMapper.writeValueAsString(event.getPacket());
            log.info("Broadcasting OVERHEAT ALERT via STOMP to /topic/events/overheat: {}", jsonStr);
            messagingTemplate.convertAndSend("/topic/events/overheat", jsonStr);
        } catch (Exception e) {
            log.error("Failed to serialize overheat event", e);
        }
    }
}
