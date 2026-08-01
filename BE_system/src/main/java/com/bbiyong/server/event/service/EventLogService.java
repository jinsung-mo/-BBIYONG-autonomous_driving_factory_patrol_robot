package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.event.dto.EventFilterRequest;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.event.repository.EventLogSpecification;
import com.bbiyong.server.notification.domain.NotificationSetting;
import com.bbiyong.server.notification.repository.NotificationSettingRepository;
import com.bbiyong.server.notification.service.MattermostNotifier;
import com.bbiyong.server.notification.service.NotificationService;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;

@Slf4j
@Service
public class EventLogService {

    private static final Set<String> ALLOWED_STATUS = Set.of("UNRESOLVED", "RESOLVED");

    private final EventLogRepository eventLogRepository;
    private final NotificationSettingRepository notificationSettingRepository;
    private final NotificationService notificationService;
    private final MattermostNotifier mattermostNotifier;

    public EventLogService(
            EventLogRepository eventLogRepository,
            NotificationSettingRepository notificationSettingRepository,
            NotificationService notificationService,
            MattermostNotifier mattermostNotifier) {
        this.eventLogRepository = eventLogRepository;
        this.notificationSettingRepository = notificationSettingRepository;
        this.notificationService = notificationService;
        this.mattermostNotifier = mattermostNotifier;
    }

    /**
     * 경보(이벤트) 상태 전이(UNRESOLVED &lt;-&gt; RESOLVED). 관제사가 경보를 처리완료로 표시한다.
     *
     * @throws ResponseStatusException 허용되지 않은 status(400) 또는 미존재 이벤트(404)
     */
    @Transactional
    public EventLog updateStatus(Long eventId, String status) {
        String normalized = status == null ? null : status.trim().toUpperCase();
        if (normalized == null || !ALLOWED_STATUS.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "유효하지 않은 status 입니다. (UNRESOLVED | RESOLVED)");
        }
        EventLog event = eventLogRepository.findById(eventId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다."));
        event.setStatus(normalized);
        return eventLogRepository.save(event);
    }

    @Transactional(readOnly = true)
    public EventPageResponse getEvents(int page, int size, String type) {
        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "timestamp"));
        Page<EventLog> result = (type == null || type.isBlank())
                ? eventLogRepository.findAll(pageable)
                : eventLogRepository.findByType(type.trim().toUpperCase(), pageable);
        return EventPageResponse.from(result);
    }

    /**
     * 고급 필터링을 지원하는 이벤트 조회
     */
    @Transactional(readOnly = true)
    public EventPageResponse getEventsWithFilters(
            int page, int size,
            String type, String level, String status,
            String robotId, String equipmentId,
            String startDate, String endDate) {

        // 필터 객체 생성
        EventFilterRequest filter = new EventFilterRequest();
        filter.setType(type);
        filter.setLevel(level);
        filter.setStatus(status);
        filter.setRobotId(robotId);
        filter.setEquipmentId(equipmentId);

        // 날짜 파싱
        if (startDate != null && !startDate.isBlank()) {
            try {
                filter.setStartDate(LocalDate.parse(startDate));
            } catch (Exception e) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 시작 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.");
            }
        }
        if (endDate != null && !endDate.isBlank()) {
            try {
                filter.setEndDate(LocalDate.parse(endDate));
            } catch (Exception e) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 종료 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.");
            }
        }

        // Specification 기반 동적 쿼리 실행
        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "timestamp"));
        Page<EventLog> result = eventLogRepository.findAll(
                EventLogSpecification.withFilters(filter),
                pageable
        );

        return EventPageResponse.from(result);
    }

    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromFire(event.getPacket()));
    }

    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromOverheat(event.getPacket()));
    }

    /**
     * 실시간 경보(AlertMessage)와 동일한 필드로 이력을 영속화한다.
     * (열화상 thermalImage 는 설계상 미저장)
     */
    private void persist(AlertMessage alert) {
        EventLog logEntry = new EventLog();
        logEntry.setType(alert.type());
        logEntry.setLevel(alert.level());
        logEntry.setMessage(alert.message());
        logEntry.setRobotId(alert.robotId());
        logEntry.setConfidence(alert.confidence());
        logEntry.setTemperature(alert.temperature());
        logEntry.setEquipmentId(alert.equipmentId());
        logEntry.setThreshold(alert.threshold());
        logEntry.setX(alert.x());
        logEntry.setY(alert.y());
        logEntry.setTimestamp(Instant.now());
        logEntry.setStatus("UNRESOLVED");

        EventLog savedEvent = eventLogRepository.save(logEntry);
        log.info("Persisted {} event log for robot: {}", alert.type(), alert.robotId());

        // Mattermost 알림 전송 (모든 사용자에게)
        sendNotificationsToAllUsers(savedEvent);
    }

    /**
     * 모든 사용자의 알림 설정을 확인하여 조건을 만족하는 경우 Mattermost 알림 전송
     */
    private void sendNotificationsToAllUsers(EventLog event) {
        try {
            List<NotificationSetting> allSettings = notificationSettingRepository.findAll();

            for (NotificationSetting setting : allSettings) {
                // shouldNotify로 필터링
                if (notificationService.shouldNotify(setting.getUserId(), event.getLevel())) {
                    mattermostNotifier.sendEventNotification(setting, event);
                }
            }
        } catch (Exception e) {
            log.error("Mattermost 알림 전송 중 오류 발생: eventId={}, error={}",
                    event.getEventId(), e.getMessage(), e);
        }
    }
}
