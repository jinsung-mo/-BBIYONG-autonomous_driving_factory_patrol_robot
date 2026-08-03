package com.bbiyong.server.notification.dto;

import com.bbiyong.server.notification.domain.NotificationSetting;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * 알림 설정 응답 DTO
 */
@Data
@Builder
public class NotificationSettingResponse {

    private Long id;
    private String userId;
    private Boolean mattermostEnabled;
    private String mattermostWebhookUrl;
    private String mattermostChannel;
    private String minSeverity;
    private Instant createdAt;
    private Instant updatedAt;

    public static NotificationSettingResponse from(NotificationSetting setting) {
        return NotificationSettingResponse.builder()
                .id(setting.getId())
                .userId(setting.getUserId())
                .mattermostEnabled(setting.getMattermostEnabled())
                .mattermostWebhookUrl(mask(setting.getMattermostWebhookUrl()))
                .mattermostChannel(setting.getMattermostChannel())
                .minSeverity(setting.getMinSeverity())
                .createdAt(setting.getCreatedAt())
                .updatedAt(setting.getUpdatedAt())
                .build();
    }

    private static String mask(String url) {
        if (url == null || url.isBlank()) return null;
        int slash = url.lastIndexOf('/');
        return slash < 0 ? "****" : url.substring(0, slash + 1) + "****";
    }
}
