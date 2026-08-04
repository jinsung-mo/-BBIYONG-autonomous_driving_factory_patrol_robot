package com.bbiyong.server.notification.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.notification.domain.NotificationSetting;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import java.util.HashMap;
import java.util.Map;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * Mattermost 웹훅 알림 발송 서비스
 */
@Slf4j
@Service
public class MattermostNotifier {

    private static final ZoneId KOREA_ZONE = ZoneId.of("Asia/Seoul");
    private static final DateTimeFormatter DISPLAY_TIME_FORMAT =
            DateTimeFormatter.ofPattern("HH시 mm분 ss초").withZone(KOREA_ZONE);

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
            throw new IllegalStateException("Mattermost 웹훅 URL이 설정되지 않았습니다.");
        }

        try {
            Map<String, Object> payload = buildPayload(setting, event);
            String jsonPayload = objectMapper.writeValueAsString(payload);

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("payload", jsonPayload);
            HttpEntity<MultiValueMap<String, String>> request = new HttpEntity<>(form, headers);

            ResponseEntity<String> response = restTemplate.postForEntity(
                    setting.getMattermostWebhookUrl(),
                    request,
                    String.class
            );

            if (response.getStatusCode().is2xxSuccessful()) {
                log.info("Mattermost 알림 전송 성공: userId={}, eventId={}", setting.getUserId(), event.getEventId());
            } else {
                throw new IllegalStateException("Mattermost 응답이 성공이 아닙니다: " + response.getStatusCode());
            }
        } catch (Exception e) {
            String failure = e instanceof RestClientResponseException responseException
                    ? "HTTP " + responseException.getStatusCode().value()
                    : e.getClass().getSimpleName();
            log.error("Mattermost 알림 전송 실패: userId={}, eventId={}, failure={}",
                    setting.getUserId(), event.getEventId(), failure);
            throw new IllegalStateException("Mattermost 알림 전송 실패", e);
        }
    }

    /**
     * Mattermost 메시지 페이로드 생성
     */
    private Map<String, Object> buildPayload(NotificationSetting setting, EventLog event) {
        Map<String, Object> payload = new HashMap<>();

        // 웹훅 생성 시 지정한 기본 채널만 쓴다. 과거 사용자 설정에 남은 채널 값은
        // 다른 채널에 권한이 없을 때 404를 만들 수 있으므로 전송 페이로드에 넣지 않는다.

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

        sb.append("### ").append(getAlertTitle(event));
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

        if (hasMeaningfulLocation(event)) {
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

        if (event.getMessage() != null && !event.getMessage().isBlank()
                && !event.getMessage().equals(getEventTypeKorean(event.getType()))) {
            sb.append("\n**메시지**: ").append(event.getMessage()).append("\n");
        }

        sb.append("\n**발생 시각**: ").append(DISPLAY_TIME_FORMAT.format(event.getTimestamp()));

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

    private String getAlertTitle(EventLog event) {
        return switch (event.getType()) {
            case "FIRE" -> "🚨 화재 발생";
            case "OVERHEAT" -> "⚠️ 과열 감지";
            default -> "ℹ️ " + getEventTypeKorean(event.getType());
        };
    }

    private boolean hasMeaningfulLocation(EventLog event) {
        return event.getX() != null && event.getY() != null
                && (Double.compare(event.getX(), 0.0) != 0 || Double.compare(event.getY(), 0.0) != 0);
    }
}
