package com.bbiyong.server.notification.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@NoArgsConstructor
@Entity
@Table(name = "notification_deliveries", uniqueConstraints = @UniqueConstraint(name = "uk_delivery_event_user", columnNames = {"event_id", "recipient_user_id"}))
public class NotificationDelivery {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(name = "event_id", nullable = false)
    private Long eventId;
    @Column(name = "recipient_user_id", nullable = false)
    private String recipientUserId;
    @Column(name = "dedupe_key", nullable = false, length = 300)
    private String dedupeKey;
    @Column(nullable = false, length = 16)
    private String status; // PENDING, SENT, FAILED
    @Column(nullable = false)
    private int attempts;
    @Column(nullable = false)
    private Instant nextAttemptAt;
    @Column(nullable = false)
    private Instant createdAt;
    @Column(length = 500)
    private String lastError;
}
