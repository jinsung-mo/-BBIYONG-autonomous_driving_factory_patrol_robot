package com.bbiyong.server.event.service;

import com.bbiyong.server.event.dto.AlertMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

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
}
