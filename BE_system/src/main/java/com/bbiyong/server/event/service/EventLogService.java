package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.event.dto.EventFilterRequest;
import com.bbiyong.server.event.dto.EventLogDetailResponse;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.event.repository.EventLogSpecification;
import com.bbiyong.server.common.config.AsyncConfig;
import com.bbiyong.server.notification.service.NotificationDispatchService;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.repository.VideoClipRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import com.bbiyong.server.wss.event.RobotConnectedEvent;
import com.bbiyong.server.wss.event.RobotDisconnectedEvent;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotCautionEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.Duration;
import java.time.LocalDate;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Slf4j
@Service
public class EventLogService {

    // ACKNOWLEDGED(확인됨·조치 진행 중) 포함 — API 문서와 일치. (S15P11E101-715)
    private static final Set<String> ALLOWED_STATUS = Set.of("UNRESOLVED", "ACKNOWLEDGED", "RESOLVED");
    private static final Duration ALERT_DEDUP_WINDOW = Duration.ofMinutes(1);

    private final EventLogRepository eventLogRepository;
    private final NotificationDispatchService notificationDispatchService;
    private final VideoClipRepository videoClipRepository;
    private final RobotWebSocketSessionManager sessionManager;
    private final AlertBroadcastService alertBroadcastService;
    private final ConcurrentHashMap<String, Instant> recentRobotAlerts = new ConcurrentHashMap<>();

    // 로봇 연결/해제를 SYSTEM 이벤트로 남길지(기본 on). 로봇별 마지막 연결상태를 들고 상태
    // 전이만 기록한다 — 세션 종료와 타임아웃 스윕이 해제 이벤트를 중복 발행해도 한 번만 남긴다.
    @Value("${bbiyong.event.log-robot-connection:true}")
    private boolean robotConnectionLogEnabled;
    private final ConcurrentHashMap<String, Boolean> robotConnected = new ConcurrentHashMap<>();

    public EventLogService(
            EventLogRepository eventLogRepository,
            NotificationDispatchService notificationDispatchService,
            VideoClipRepository videoClipRepository,
            RobotWebSocketSessionManager sessionManager,
            AlertBroadcastService alertBroadcastService) {
        this.eventLogRepository = eventLogRepository;
        this.notificationDispatchService = notificationDispatchService;
        this.videoClipRepository = videoClipRepository;
        this.sessionManager = sessionManager;
        this.alertBroadcastService = alertBroadcastService;
    }

    /**
     * 경보(이벤트) 상태 전이(UNRESOLVED | ACKNOWLEDGED | RESOLVED). 관제사가 경보 확인/처리완료를 표시한다.
     *
     * @throws ResponseStatusException 허용되지 않은 status(400) 또는 미존재 이벤트(404)
     */
    @Transactional
    public EventLog updateStatus(Long eventId, String status) {
        String normalized = status == null ? null : status.trim().toUpperCase();
        if (normalized == null || !ALLOWED_STATUS.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "유효하지 않은 status 입니다. (UNRESOLVED | ACKNOWLEDGED | RESOLVED)");
        }
        EventLog event = eventLogRepository.findById(eventId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다."));
        event.setStatus(normalized);
        return eventLogRepository.save(event);
    }

    /**
     * 이벤트(경보) 이력 삭제. 테스트/더미로 유입된 이벤트 정리용. 미존재 시 404.
     * 연관 영상(video_clips.event_id)은 유지되며 참조만 남는다.
     */
    @Transactional
    public void delete(Long eventId) {
        if (!eventLogRepository.existsById(eventId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다.");
        }
        eventLogRepository.deleteById(eventId);
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

    /**
     * 이벤트 로그 상세 조회 (연관 영상 정보 포함)
     */
    @Transactional(readOnly = true)
    public EventLogDetailResponse getEventDetail(Long eventId) {
        EventLog event = eventLogRepository.findById(eventId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다."));

        // 연관 영상 조회
        List<VideoResponses.Summary> videos = videoClipRepository
                .findByEventIdOrderByStartedAtDesc(eventId)
                .stream()
                .map(VideoResponses.Summary::of)
                .toList();

        return EventLogDetailResponse.from(event, videos);
    }

    /**
     * 이벤트에 영상이 존재하는지 확인
     */
    @Transactional(readOnly = true)
    public boolean hasVideo(Long eventId) {
        return videoClipRepository.existsByEventId(eventId);
    }

    // @Async: 경보 영속화(DB write)를 WSS 수신 스레드에서 분리한다. 커넥션 풀(개발 SQLite 1개)
    // 경합 시 텔레메트리·영상 프레임 처리가 함께 막히는 것을 방지한다. 단일 스레드 executor 로
    // 수신 순서·dedup 직렬성은 보존된다. (S15P11E101-715)
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromFire(event.getPacket()), null);
    }

    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromOverheat(event.getPacket()), null);
    }

    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleCautionEvent(RobotCautionEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromCaution(event.getPacket()), null);
    }

    /**
     * 로봇 연결 — SYSTEM 이벤트로 남긴다. 이벤트 탭 '시스템' 필터에서 연결 이력을 볼 수 있다.
     * 상태 전이(연결 안됨 → 연결됨)일 때만 기록해 재연결·중복 발행을 걸러낸다.
     */
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleRobotConnected(RobotConnectedEvent event) {
        if (!robotConnectionLogEnabled) {
            return;
        }
        String robotId = event.getRobotId();
        if (Boolean.TRUE.equals(robotConnected.put(robotId, Boolean.TRUE))) {
            return; // 이미 연결됨으로 기록됨
        }
        saveSystemEvent(robotId, "로봇 " + robotId + " 연결됨");
    }

    /**
     * 로봇 연결 해제 — SYSTEM 이벤트로 남긴다.
     * 세션 종료와 타임아웃 스윕이 해제 이벤트를 각각 발행하므로, 상태 전이일 때만 한 번 기록한다.
     */
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleRobotDisconnected(RobotDisconnectedEvent event) {
        if (!robotConnectionLogEnabled) {
            return;
        }
        String robotId = event.getRobotId();
        if (Boolean.FALSE.equals(robotConnected.put(robotId, Boolean.FALSE))) {
            return; // 이미 연결 끊김으로 기록됨(중복 발행 방지)
        }
        saveSystemEvent(robotId, "로봇 " + robotId + " 연결 끊김");
    }

    /** 정보성 SYSTEM 이벤트 저장(연결/해제 로그 등). 조치 대상이 아니므로 status=RESOLVED. */
    private void saveSystemEvent(String robotId, String message) {
        EventLog entry = new EventLog();
        entry.setType("SYSTEM");
        entry.setLevel("INFO");
        entry.setRobotId(robotId);
        entry.setMessage(message);
        entry.setTimestamp(Instant.now());
        entry.setStatus("RESOLVED");
        entry.setSimulated(false);
        eventLogRepository.save(entry);
        log.info("SYSTEM event logged: {}", message);
    }

    private void persist(AlertMessage alert, String simulationRecipientUserId) {
        String messageId = normalizeMessageId(alert);
        if (messageId != null && eventLogRepository.findByMessageId(messageId).isPresent()) {
            log.info("Suppressing duplicate {} alert with messageId={}", alert.type(), messageId);
            return;
        }
        DeduplicationAttempt deduplication = acquireDeduplication(alert);
        if (deduplication.duplicate()) {
            log.info("Suppressing duplicate {} alert for robot {} within {} seconds",
                    alert.type(), alert.robotId(), ALERT_DEDUP_WINDOW.toSeconds());
            return;
        }

        EventLog logEntry = new EventLog();
        logEntry.setType(alert.type());
        logEntry.setLevel(alert.level());
        logEntry.setMessage(alert.message());
        logEntry.setRobotId(alert.robotId());
        logEntry.setMessageId(normalizeMessageId(alert));
        logEntry.setConfidence(alert.confidence());
        logEntry.setTemperature(alert.temperature());
        logEntry.setEquipmentId(alert.equipmentId());
        logEntry.setThreshold(alert.threshold());
        logEntry.setX(alert.x());
        logEntry.setY(alert.y());
        logEntry.setTimestamp(Instant.parse(alert.timestamp()));
        logEntry.setStatus("UNRESOLVED");
        logEntry.setSimulated("SIMULATION".equals(alert.source()));

        EventLog savedEvent;
        try {
            savedEvent = hasMessageId(alert) ? eventLogRepository.saveAndFlush(logEntry) : eventLogRepository.save(logEntry);
        } catch (DataIntegrityViolationException duplicateMessageId) {
            if (hasMessageId(alert)) {
                log.info("Suppressing concurrently persisted {} alert with messageId={}", alert.type(), alert.messageId());
                rollbackDeduplication(deduplication);
                return;
            }
            rollbackDeduplication(deduplication);
            throw duplicateMessageId;
        } catch (RuntimeException e) {
            rollbackDeduplication(deduplication);
            throw e;
        }
        log.info("Persisted {} event log for robot: {}", alert.type(), alert.robotId());

        // 이벤트 클립 연결을 위해 로봇에 생성된 eventId 를 회신한다(블랙박스 파이프라인). (S15P11E101-588)
        notifyRobotEventSaved(savedEvent);

        // 저장이 끝난 동일 이벤트의 식별자를 STOMP에 실어 즉시 상세 조회할 수 있게 한다.
        alertBroadcastService.broadcast(alert.withEventId(savedEvent.getEventId()));
        notificationDispatchService.enqueue(savedEvent, simulationRecipientUserId);
    }

    private DeduplicationAttempt acquireDeduplication(AlertMessage alert) {
        // message_id가 있는 새 로봇은 DB unique 제약이 재시작·다중 인스턴스까지 보장한다.
        if (hasMessageId(alert)) {
            return DeduplicationAttempt.notApplied();
        }
        if (!"ROBOT".equals(alert.source()) || alert.robotId() == null || alert.robotId().isBlank()) {
            return DeduplicationAttempt.notApplied();
        }

        String key = alert.robotId().trim() + ":" + alert.type();
        Instant receivedAt = Instant.now();
        AtomicBoolean duplicate = new AtomicBoolean(false);
        recentRobotAlerts.compute(key, (ignored, previousReceivedAt) -> {
            if (previousReceivedAt != null
                    && previousReceivedAt.plus(ALERT_DEDUP_WINDOW).isAfter(receivedAt)) {
                duplicate.set(true);
                return previousReceivedAt;
            }
            return receivedAt;
        });
        return new DeduplicationAttempt(key, receivedAt, duplicate.get());
    }

    private void rollbackDeduplication(DeduplicationAttempt attempt) {
        if (!attempt.duplicate() && attempt.key() != null) {
            recentRobotAlerts.remove(attempt.key(), attempt.receivedAt());
        }
    }

    private boolean hasMessageId(AlertMessage alert) {
        return alert.messageId() != null && !alert.messageId().isBlank();
    }

    private String normalizeMessageId(AlertMessage alert) {
        return hasMessageId(alert) ? alert.messageId().trim() : null;
    }

    private record DeduplicationAttempt(String key, Instant receivedAt, boolean duplicate) {
        private static DeduplicationAttempt notApplied() {
            return new DeduplicationAttempt(null, null, false);
        }
    }

    /**
     * 만료된 dedup 엔트리를 주기적으로 제거한다. 제거 로직이 없으면 임의 robot_id 로
     * 경보를 주입하는 공격/오동작 시 맵이 무한히 자라는 메모리 릭이 된다. (S15P11E101-715)
     */
    @Scheduled(fixedDelay = 60_000)
    void sweepExpiredDeduplicationEntries() {
        Instant cutoff = Instant.now().minus(ALERT_DEDUP_WINDOW);
        recentRobotAlerts.entrySet().removeIf(entry -> entry.getValue().isBefore(cutoff));
    }

    /**
     * 이벤트 저장 직후, 로봇에게 생성된 {@code eventId} 를 EVENT_SAVED 로 회신한다.
     *
     * <p>로봇은 회신받은 eventId 로 {@code POST /api/videos/upload?eventId=..&clipType=EVENT}
     * 업로드해 이벤트-클립을 연결한다(설계문서 §3 옵션1). 로봇 미연결/전송 실패는 이벤트
     * 영속화에 영향을 주지 않도록 조용히 로깅만 한다.
     */
    private void notifyRobotEventSaved(EventLog event) {
        String robotId = event.getRobotId();
        if (robotId == null || robotId.isBlank()) {
            return;
        }
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "EVENT_SAVED");
            payload.put("eventId", event.getEventId());
            payload.put("type", event.getType());
            boolean sent = sessionManager.sendCommand(robotId, payload);
            if (!sent) {
                log.warn("EVENT_SAVED 회신 실패(로봇 미연결): robot={}, eventId={}", robotId, event.getEventId());
            }
        } catch (Exception e) {
            log.error("EVENT_SAVED 회신 중 오류: robot={}, eventId={}, error={}",
                    robotId, event.getEventId(), e.getMessage(), e);
        }
    }

}
