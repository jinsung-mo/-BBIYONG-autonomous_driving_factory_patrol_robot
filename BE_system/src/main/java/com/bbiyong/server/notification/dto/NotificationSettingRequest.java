package com.bbiyong.server.notification.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

/**
 * 알림 설정 요청 DTO
 */
@Data
public class NotificationSettingRequest {

    /**
     * Mattermost 알림 활성화 여부
     */
    private Boolean mattermostEnabled;

    /**
     * Mattermost Webhook URL
     */
    private String mattermostWebhookUrl;

    /**
     * Mattermost 채널명
     */
    private String mattermostChannel;

    /**
     * 알림 최소 심각도 (CRITICAL, WARNING)
     */
    private String minSeverity;
}
