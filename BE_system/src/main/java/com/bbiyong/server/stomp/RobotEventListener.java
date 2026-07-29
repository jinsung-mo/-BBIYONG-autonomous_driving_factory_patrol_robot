package com.bbiyong.server.stomp;

import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotNavEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import com.bbiyong.server.wss.event.RobotVideoEvent;
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
            log.debug("Broadcasting telemetry via STOMP to /topic/robots: {}", jsonStr);
            messagingTemplate.convertAndSend("/topic/robots", jsonStr);
        } catch (Exception e) {
            log.error("Failed to serialize telemetry event", e);
        }
    }

    @EventListener
    public void handleVideoEvent(RobotVideoEvent event) {
        String robotId = event.getPacket().getRobotId();
        if (robotId == null || robotId.isBlank()) {
            log.warn("Dropping VIDEO_FRAME with missing robot_id");
            return;
        }
        try {
            String jsonStr = objectMapper.writeValueAsString(event.getPacket());
            messagingTemplate.convertAndSend("/topic/video/" + robotId, jsonStr);
        } catch (Exception e) {
            log.error("Failed to serialize/relay video frame for robot [{}]", robotId, e);
        }
    }

    @EventListener
    public void handleNavEvent(RobotNavEvent event) {
        // 맵 원문(raw JSON)을 그대로 중계한다 — cells(RLE) 재직렬화 없이.
        String robotId = event.getRobotId();
        try {
            messagingTemplate.convertAndSend("/topic/nav/" + robotId, event.getRawPayload());
        } catch (Exception e) {
            log.error("Failed to relay nav/map for robot [{}]", robotId, e);
        }
    }

    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        broadcastAlert(AlertMessage.fromFire(event.getPacket()));
    }

    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        broadcastAlert(AlertMessage.fromOverheat(event.getPacket()));
    }

    /** 화재/과열 확정 경보를 단일 /topic/alerts 로 표준 페이로드 브로드캐스트. */
    private void broadcastAlert(AlertMessage alert) {
        try {
            String jsonStr = objectMapper.writeValueAsString(alert);
            log.info("Broadcasting {} ALERT via STOMP to /topic/alerts: {}", alert.type(), jsonStr);
            messagingTemplate.convertAndSend("/topic/alerts", jsonStr);
        } catch (Exception e) {
            log.error("Failed to serialize/broadcast alert", e);
        }
    }
}
