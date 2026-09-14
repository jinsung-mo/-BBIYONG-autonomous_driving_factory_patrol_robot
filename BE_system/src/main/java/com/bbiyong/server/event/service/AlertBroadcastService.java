package com.bbiyong.server.event.service;

import com.bbiyong.server.event.dto.AlertMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;

/** 저장이 완료된 경보만 관제 대시보드에 전달한다. */
@Slf4j
@Component
public class AlertBroadcastService {

    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;

    public AlertBroadcastService(SimpMessagingTemplate messagingTemplate, ObjectMapper objectMapper) {
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
    }

    public void broadcast(AlertMessage alert) {
        try {
            String json = objectMapper.writeValueAsString(alert);
            messagingTemplate.convertAndSend("/topic/alerts", json);
        } catch (Exception e) {
            log.error("Failed to serialize/broadcast {} alert", alert.type(), e);
        }
    }

    /**
     * 이벤트 상태 변경을 실시간으로 브로드캐스트한다.
     * 관제 FE에서 /topic/events/status 를 구독하면 이벤트 해결 시 실시간으로 핑이 사라진다.
     *
     * @param eventId 변경된 이벤트 ID
     * @param status 새로운 상태 (UNRESOLVED, ACKNOWLEDGED, RESOLVED)
     */
    public void broadcastStatusChange(Long eventId, String status) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("eventId", eventId);
            payload.put("status", status);
            payload.put("timestamp", System.currentTimeMillis());

            String json = objectMapper.writeValueAsString(payload);
            messagingTemplate.convertAndSend("/topic/events/status", json);
            log.info("Broadcasted event status change: eventId={}, status={}", eventId, status);
        } catch (Exception e) {
            log.error("Failed to broadcast event status change for eventId={}", eventId, e);
        }
    }
}
