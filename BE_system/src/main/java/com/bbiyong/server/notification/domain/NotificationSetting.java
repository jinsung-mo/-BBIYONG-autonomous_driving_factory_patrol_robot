package com.bbiyong.server.notification.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 알림 설정 엔티티
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "notification_settings")
public class NotificationSetting {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /**
     * 사용자 ID (관리자)
     */
    @Column(nullable = false)
    private String userId;

    /**
     * Mattermost 알림 활성화 여부
     */
    @Column(nullable = false)
    private Boolean mattermostEnabled = false;

    /**
     * Mattermost Webhook URL
     */
    @Column(length = 500)
    private String mattermostWebhookUrl;

    /**
     * Mattermost 채널명
     */
    @Column(length = 100)
    private String mattermostChannel;

    /**
     * 알림 최소 심각도 (CRITICAL, WARNING)
     * WARNING 이상만 알림 = WARNING, CRITICAL 모두 알림
     */
    @Column(length = 20)
    private String minSeverity = "WARNING";

    /**
     * 생성 시각
     */
    @Column(nullable = false)
    private Instant createdAt;

    /**
     * 수정 시각
     */
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }
}
