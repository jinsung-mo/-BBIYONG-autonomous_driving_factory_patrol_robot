package com.bbiyong.server.notification.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.notification.domain.NotificationSetting;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

/**
 * Mattermost 웹훅 알림 발송 서비스
 */
@Slf4j
@Service
public class MattermostNotifier {

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    public MattermostNotifier(RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    /**
     * Mattermost로 이벤트 알림 전송
     */
    public void sendEventNotification(NotificationSetting setting, EventLog event) {
        if (setting.getMattermostWebhookUrl() == null || setting.getMattermostWebhookUrl().isBlank()) {
            log.warn("Mattermost 웹훅 URL이 설정되지 않음: userId={}", setting.getUserId());
            return;
        }

        try {
            Map<String, Object> payload = buildPayload(setting, event);
            String jsonPayload = objectMapper.writeValueAsString(payload);

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            HttpEntity<String> request = new HttpEntity<>(jsonPayload, headers);

            ResponseEntity<String> response = restTemplate.postForEntity(
                    setting.getMattermostWebhookUrl(),
                    request,
                    String.class
            );

            if (response.getStatusCode().is2xxSuccessful()) {
                log.info("Mattermost 알림 전송 성공: userId={}, eventId={}", setting.getUserId(), event.getEventId());
            } else {
                log.error("Mattermost 알림 전송 실패: status={}, userId={}", response.getStatusCode(), setting.getUserId());
            }
        } catch (Exception e) {
            log.error("Mattermost 알림 전송 중 오류 발생: userId={}, eventId={}, error={}",
                    setting.getUserId(), event.getEventId(), e.getMessage(), e);
        }
    }

    /**
     * Mattermost 메시지 페이로드 생성
     */
    private Map<String, Object> buildPayload(NotificationSetting setting, EventLog event) {
        Map<String, Object> payload = new HashMap<>();

        // 채널 설정
        if (setting.getMattermostChannel() != null && !setting.getMattermostChannel().isBlank()) {
            payload.put("channel", setting.getMattermostChannel());
        }

        // 사용자명
        payload.put("username", "BBIYONG 관제 시스템");

        // 아이콘 (이벤트 레벨에 따라)
        String iconEmoji = getIconEmoji(event.getLevel());
        payload.put("icon_emoji", iconEmoji);

        // 메시지 텍스트
        String text = buildMessageText(event);
        payload.put("text", text);

        return payload;
    }

    /**
     * 이벤트 레벨에 따른 이모지 선택
     */
    private String getIconEmoji(String level) {
        if ("CRITICAL".equals(level)) {
            return ":fire:";
        } else if ("WARNING".equals(level)) {
            return ":warning:";
        } else {
            return ":information_source:";
        }
    }

    /**
     * 알림 메시지 텍스트 생성
     */
    private String buildMessageText(EventLog event) {
        StringBuilder sb = new StringBuilder();

        // 헤더
        sb.append("### ");
        if ("CRITICAL".equals(event.getLevel())) {
            sb.append("🚨 긴급 알림");
        } else if ("WARNING".equals(event.getLevel())) {
            sb.append("⚠️ 경고 알림");
        } else {
            sb.append("ℹ️ 정보 알림");
        }
        sb.append("\n\n");

        // 이벤트 정보
        sb.append("**이벤트 유형**: ").append(getEventTypeKorean(event.getType())).append("\n");
        sb.append("**심각도**: ").append(event.getLevel()).append("\n");

        if (event.getRobotId() != null) {
            sb.append("**로봇 ID**: ").append(event.getRobotId()).append("\n");
        }

        if (event.getEquipmentId() != null) {
            sb.append("**설비 ID**: ").append(event.getEquipmentId()).append("\n");
        }

        if (event.getX() != null && event.getY() != null) {
            sb.append("**위치**: (").append(String.format("%.2f", event.getX()))
              .append(", ").append(String.format("%.2f", event.getY())).append(")\n");
        }

        if (event.getTemperature() != null) {
            sb.append("**온도**: ").append(String.format("%.1f", event.getTemperature())).append("°C");
            if (event.getThreshold() != null) {
                sb.append(" (임계값: ").append(String.format("%.1f", event.getThreshold())).append("°C)");
            }
            sb.append("\n");
        }

        if (event.getConfidence() != null) {
            sb.append("**신뢰도**: ").append(String.format("%.1f", event.getConfidence() * 100)).append("%\n");
        }

        // 메시지
        sb.append("\n**메시지**: ").append(event.getMessage()).append("\n");

        // 타임스탬프
        sb.append("\n**발생 시각**: ").append(event.getTimestamp().toString());

        return sb.toString();
    }

    /**
     * 이벤트 유형 한글 변환
     */
    private String getEventTypeKorean(String type) {
        switch (type) {
            case "FIRE":
                return "화재 감지";
            case "OVERHEAT":
                return "과열 감지";
            case "SYSTEM":
                return "시스템 이벤트";
            default:
                return type;
        }
    }
}
