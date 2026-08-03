package com.bbiyong.server.notification.repository;

import com.bbiyong.server.notification.domain.NotificationDelivery;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;

public interface NotificationDeliveryRepository extends JpaRepository<NotificationDelivery, Long> {
    List<NotificationDelivery> findTop50ByStatusAndNextAttemptAtLessThanEqualOrderByCreatedAtAsc(String status, Instant now);
    boolean existsByRecipientUserIdAndDedupeKeyAndCreatedAtAfter(String recipientUserId, String dedupeKey, Instant since);
}
