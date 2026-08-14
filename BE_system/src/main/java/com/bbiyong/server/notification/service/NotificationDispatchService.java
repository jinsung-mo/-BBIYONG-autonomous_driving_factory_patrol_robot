package com.bbiyong.server.notification.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.notification.domain.NotificationDelivery;
import com.bbiyong.server.notification.domain.NotificationSetting;
import com.bbiyong.server.notification.repository.NotificationDeliveryRepository;
import com.bbiyong.server.notification.repository.NotificationSettingRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

@Slf4j
@Service
public class NotificationDispatchService {
    private static final int MAX_ATTEMPTS = 3;
    private final NotificationSettingRepository settingRepository;
    private final NotificationDeliveryRepository deliveryRepository;
    private final EventLogRepository eventLogRepository;
    private final NotificationService notificationService;
    private final MattermostNotifier mattermostNotifier;

    public NotificationDispatchService(NotificationSettingRepository settingRepository,
            NotificationDeliveryRepository deliveryRepository, EventLogRepository eventLogRepository,
            NotificationService notificationService, MattermostNotifier mattermostNotifier) {
        this.settingRepository = settingRepository;
        this.deliveryRepository = deliveryRepository;
        this.eventLogRepository = eventLogRepository;
        this.notificationService = notificationService;
        this.mattermostNotifier = mattermostNotifier;
    }

    @Transactional
    public void enqueue(EventLog event, String simulationRecipientUserId) {
        List<NotificationSetting> settings = simulationRecipientUserId == null
                ? settingRepository.findAll()
                : settingRepository.findByUserId(simulationRecipientUserId).map(List::of).orElseGet(List::of);
        Instant now = Instant.now();
        for (NotificationSetting setting : settings) {
            if (!notificationService.shouldNotify(setting, event.getLevel())) continue;
            String dedupeKey = event.getMessageId() != null && !event.getMessageId().isBlank()
                    ? "message:" + event.getMessageId()
                    : event.getType() + ":" + nullToEmpty(event.getRobotId()) + ":" + nullToEmpty(event.getEquipmentId());
            if (!event.isSimulated() && deliveryRepository.existsByRecipientUserIdAndDedupeKeyAndCreatedAtAfter(
                    setting.getUserId(), dedupeKey, now.minus(1, ChronoUnit.MINUTES))) continue;
            NotificationDelivery delivery = new NotificationDelivery();
            delivery.setEventId(event.getEventId());
            delivery.setRecipientUserId(setting.getUserId());
            delivery.setDedupeKey(dedupeKey);
            delivery.setStatus("PENDING");
            delivery.setAttempts(0);
            delivery.setCreatedAt(now);
            delivery.setNextAttemptAt(now);
            deliveryRepository.save(delivery);
        }
    }

    @Scheduled(fixedDelayString = "${bbiyong.mattermost.dispatch-delay-ms:5000}")
    @Transactional
    public void dispatchPending() {
        for (NotificationDelivery delivery : deliveryRepository.findTop50ByStatusAndNextAttemptAtLessThanEqualOrderByCreatedAtAsc("PENDING", Instant.now())) {
            deliver(delivery);
        }
    }

    private void deliver(NotificationDelivery delivery) {
        EventLog event = eventLogRepository.findById(delivery.getEventId()).orElse(null);
        NotificationSetting setting = settingRepository.findByUserId(delivery.getRecipientUserId()).orElse(null);
        if (event == null || setting == null || !notificationService.shouldNotify(setting, event.getLevel())) {
            failPermanently(delivery, "이벤트 또는 알림 설정을 찾을 수 없습니다.");
            return;
        }
        try {
            mattermostNotifier.sendEventNotification(setting, event);
            delivery.setStatus("SENT");
            delivery.setAttempts(delivery.getAttempts() + 1);
            delivery.setLastError(null);
        } catch (RuntimeException e) {
            int attempts = delivery.getAttempts() + 1;
            delivery.setAttempts(attempts);
            delivery.setLastError("Mattermost 요청 실패");
            if (attempts >= MAX_ATTEMPTS) delivery.setStatus("FAILED");
            else delivery.setNextAttemptAt(Instant.now().plus(attempts * 5L, ChronoUnit.SECONDS));
        }
    }

    private void failPermanently(NotificationDelivery delivery, String reason) {
        delivery.setStatus("FAILED");
        delivery.setLastError(reason);
    }

    private String nullToEmpty(String value) { return value == null ? "" : value; }
}
